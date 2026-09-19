import { Console, Effect, FileSystem, Layer, Path, Schema } from 'effect'

import { Tool, Toolkit } from 'effect/unstable/ai'
import type { ChildProcessSpawner } from 'effect/unstable/process'

import * as Bash from './bash.ts'
import { FileSystemRefused, refused } from './errors.ts'
import { Files } from './files.ts'
import * as Glob from './glob.ts'
import * as ReadFile from './read-file.ts'
import { countOccurrences, numbered, toLines } from './text.ts'
import * as WriteFile from './write-file.ts'
import { Workspace } from '../workspace.ts'

// The tools' errors are raised by the tool that owns them and re-exported here, so
// a caller still finds the whole vocabulary in one import.
export { CommandRefused, CommandTimedOut } from './bash.ts'

export { FileSystemRefused } from './errors.ts'

export { FileIsBinary } from './read-file.ts'

export { FileNotRead } from './write-file.ts'

const CONTEXT_LINES = 3

const BYTE_ORDER_MARK = '\uFEFF'

export class TextNotFound extends Schema.TaggedError<TextNotFound>()('TextNotFound', {
  path: Schema.String,
  reason: Schema.String,
}) {}

export class TextNotUnique extends Schema.TaggedError<TextNotUnique>()('TextNotUnique', {
  path: Schema.String,
  occurrences: Schema.Int,
  reason: Schema.String,
}) {}

type Newline = '\n' | '\r\n'

const markOf = (text: string): '' | typeof BYTE_ORDER_MARK =>
  text.startsWith(BYTE_ORDER_MARK) ? BYTE_ORDER_MARK : ''

// Rewrite the line endings of `text` to `newline`. Passing '\n' normalises.
const reframe = (text: string, newline: Newline): string =>
  text.replaceAll('\r\n', '\n').replaceAll('\n', newline)

// Both endings, the one the file opens with first. Nothing is rewritten to match:
// the needle moves to the file, not the file to the needle, so a file of mixed
// endings keeps every ending it had.
const endings = (contents: string): readonly [Newline, Newline] => {
  const first = contents.indexOf('\n')

  return first > 0 && contents[first - 1] === '\r' ? ['\r\n', '\n'] : ['\n', '\r\n']
}

// One way the model's text could be framed to sit in this file.
type Framing = {
  readonly original: string
  readonly replacement: string
}

// Where a framing lands. A needle of a single line reads the same either way, so a
// file is only ever searched twice for a needle that spans lines — and then each
// occurrence is replaced in the framing it was found in, which is what lets
// replace_all reach every one of them in a file of mixed endings.
type Sighting = {
  readonly at: number
  readonly framing: Framing
  readonly occurrences: number
}

const sightings = (contents: string, sought: string, wanted: string): ReadonlyArray<Sighting> => {
  const [opens, other] = endings(contents)

  const opening: Framing = {
    original: reframe(sought, opens),
    replacement: reframe(wanted, opens),
  }

  const alternate: Framing = {
    original: reframe(sought, other),
    replacement: reframe(wanted, other),
  }

  const distinct = opening.original === alternate.original ? [opening] : [opening, alternate]

  return distinct.flatMap((framing) => {
    const at = contents.indexOf(framing.original)

    return at === -1
      ? []
      : [{ at, framing, occurrences: countOccurrences(contents, framing.original) }]
  })
}

const editFile = Tool.make('edit_file', {
  description: [
    'Replace text in file. `old_text` must appear exactly once: when it appears more often the',
    'edit is refused, so extend it with surrounding lines until it identifies one place, or pass',
    '`replace_all` to change every occurrence. Both texts are matched and inserted literally.',
    'The result shows the edited lines with their numbers.',
  ].join(' '),
  parameters: Schema.Struct({
    path: Schema.String,
    old_text: Schema.String,
    new_text: Schema.String,
    replace_all: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.String,
  failure: Schema.Union([TextNotFound, TextNotUnique, FileSystemRefused]),
  failureMode: 'return',
})

const core = Toolkit.make(editFile)

export const toolkit = Toolkit.merge(
  core,
  Bash.toolkit,
  Glob.toolkit,
  ReadFile.toolkit,
  WriteFile.toolkit,
)

export type Handlers = Tool.HandlersFor<(typeof toolkit)['tools']>

export const toolkitLayer: Layer.Layer<
  Handlers,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Layer.mergeAll(
  Bash.layer,
  Glob.layer,
  ReadFile.layer,
  WriteFile.layer,
  core.toLayer(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const root = yield* Workspace

      const files = yield* Files

      return core.of({
        edit_file: Effect.fn('edit_file')(function* ({
          new_text: wanted,
          old_text: sought,
          path: target,
          replace_all: every,
        }) {
          yield* Console.log(`edit ${target}`)

          const resolved = path.resolve(root, target)

          const bytes = yield* fs.readFile(resolved).pipe(Effect.mapError(refused))

          // `ignoreBOM` keeps a leading BOM as a character rather than dropping it, so
          // the file can be written back with the mark it had.
          const decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)

          const mark = markOf(decoded)

          const contents = decoded.slice(mark.length)

          if (sought === '') {
            return yield* new TextNotFound({
              path: target,
              reason: `edit_file was given an empty old_text — pass the text to replace, copied from ${target}`,
            })
          }

          // The model types plain newlines whatever the file uses, so move its text to the
          // file's convention rather than making it guess.
          const found = sightings(contents, sought, wanted)

          const occurrences = found.reduce((total, sighting) => total + sighting.occurrences, 0)

          if (occurrences === 0) {
            return yield* new TextNotFound({
              path: target,
              reason: `edit_file found no occurrence of old_text in ${target} — read the file and retry with text copied from it`,
            })
          }

          if (occurrences > 1 && every !== true) {
            return yield* new TextNotUnique({
              path: target,
              occurrences,
              reason: `edit_file found ${occurrences} occurrences of old_text in ${target} and will not guess between them — extend old_text with the lines around the one you mean, or pass replace_all to change all ${occurrences}`,
            })
          }

          // One sighting of one occurrence when the match was unique, every sighting when
          // replace_all asked for them, and each replaced in the framing it was found in.
          const edited = found.reduce(
            (text, sighting) =>
              text.split(sighting.framing.original).join(sighting.framing.replacement),
            contents,
          )

          yield* files.write(resolved, mark + edited)

          yield* files.remember(resolved)

          const anchor = found.reduce((first, sighting) =>
            sighting.at < first.at ? sighting : first,
          )

          const editedLines = toLines(reframe(edited, '\n'))

          const firstEdited = toLines(contents.slice(0, anchor.at)).length

          const from = Math.max(0, firstEdited - 1 - CONTEXT_LINES)

          const to = Math.min(
            editedLines.length,
            firstEdited + toLines(anchor.framing.replacement).length + CONTEXT_LINES,
          )

          const snippet = numbered(editedLines.slice(from, to), from + 1)

          return `Edited ${target} (${occurrences} ${occurrences === 1 ? 'replacement' : 'replacements'})\n${snippet}`
        }),
      })
    }),
  ),
).pipe(Layer.provide(Files.layer))
