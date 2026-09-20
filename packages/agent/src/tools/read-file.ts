import { Effect, FileSystem, Path, Schema } from 'effect'

import type { Layer } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'

import { FileSystemRefused, refused } from './errors.ts'
import { Files } from './files.ts'
import { numbered, toLines } from './text.ts'
import { Workspace } from '#workspace.ts'

const DEFAULT_LINE_LIMIT = 2000

const MAX_READ_CHARACTERS = 100_000

const BINARY_SNIFF_BYTES = 8_000

export class FileIsBinary extends Schema.TaggedError<FileIsBinary>()('FileIsBinary', {
  path: Schema.String,
  reason: Schema.String,
}) {}

const Lines = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

type Clipped = {
  readonly clipped: boolean
  readonly lines: ReadonlyArray<string>
}

const clip = (lines: ReadonlyArray<string>, budget: number): Clipped => {
  const kept: Array<string> = []

  let used = 0

  for (const line of lines) {
    const room = budget - used

    if (room <= 0) {
      return { clipped: true, lines: kept }
    }

    if (line.length > room) {
      kept.push(line.slice(0, room))

      return { clipped: true, lines: kept }
    }

    kept.push(line)

    used += line.length + 1
  }

  return { clipped: false, lines: kept }
}

type View = {
  readonly complete: boolean
  readonly text: string
}

const view = (lines: ReadonlyArray<string>, from: number, limit: number, budget: number): View => {
  const selected = lines.slice(from, from + limit)

  const shown = clip(selected, budget)

  // Counted against what was actually shown, not what the line limit selected: when the
  // budget cuts the selection short as well, the offset to continue from has to name the
  // first line the model has not seen, or the lines the budget dropped are skipped over
  // in silence.
  const remaining = lines.length - from - shown.lines.length

  const notes = [
    shown.clipped ? `truncated at ${budget} characters` : undefined,
    remaining === 0
      ? undefined
      : `${remaining} more lines; continue with offset ${from + shown.lines.length + 1}`,
  ].filter((note) => note !== undefined)

  const body = numbered(shown.lines, from + 1)

  return {
    complete: from === 0 && remaining === 0 && !shown.clipped,
    text: notes.length === 0 ? body : `${body}\n... (${notes.join('; ')})`,
  }
}

const readFile = Tool.make('read_file', {
  description: [
    'Read file contents. Each line is prefixed with its number and an arrow, as in `     1→text`;',
    'that prefix is not part of the file, so never copy it into edit_file. Reads from `offset`',
    "(the first line, counting from 1) and stops after `limit` lines, saying what it didn't show",
    'and the offset to continue from. Long results are cut to a character budget as well, so a',
    'file of very long lines comes back clipped.',
  ].join(' '),
  parameters: Schema.Struct({
    path: Schema.String,
    offset: Schema.optionalKey(Lines),
    limit: Schema.optionalKey(Lines),
  }),
  success: Schema.String,
  failure: Schema.Union([FileIsBinary, FileSystemRefused]),
  failureMode: 'return',
})

export const toolkit: Toolkit.Toolkit<{ readonly read_file: typeof readFile }> =
  Toolkit.make(readFile)

export const layer: Layer.Layer<
  Tool.HandlersFor<(typeof toolkit)['tools']>,
  never,
  Files | FileSystem.FileSystem | Path.Path
> = toolkit.toLayer(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const root = yield* Workspace

    const files = yield* Files

    return toolkit.of({
      read_file: Effect.fn('read_file')(function* ({ limit, offset, path: target }) {
        const resolved = path.resolve(root, target)

        const bytes = yield* fs.readFile(resolved).pipe(Effect.mapError(refused))

        if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
          return yield* new FileIsBinary({
            path: target,
            reason: `read_file will not decode ${target}: the bytes include NUL, so it is not text — inspect it with bash if you need to`,
          })
        }

        const contents = new TextDecoder().decode(bytes)

        if (contents === '') {
          yield* files.remember(resolved)

          return '(empty file)'
        }

        const lines = toLines(contents)

        const from = (offset ?? 1) - 1

        if (from >= lines.length) {
          return `(offset ${offset ?? 1} is past the end of ${target}, which has ${lines.length} lines)`
        }

        const shown = view(lines, from, limit ?? DEFAULT_LINE_LIMIT, MAX_READ_CHARACTERS)

        if (shown.complete) {
          yield* files.remember(resolved)
        }

        return shown.text
      }),
    })
  }),
)
