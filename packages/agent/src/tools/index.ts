import {
  Console,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Random,
  Ref,
  Schema,
  Stream,
} from 'effect'

import type { Layer } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { FileSystemRefused, refused } from './errors.ts'
import { countOccurrences, numbered, toLines } from './text.ts'
import { Workspace } from '../workspace.ts'

export { FileSystemRefused } from './errors.ts'

const MAX_MATCHES = 200

const PREVIEW_CHARACTERS = 200

const DEFAULT_LINE_LIMIT = 2000

const MAX_READ_CHARACTERS = 100_000

const MAX_OUTPUT_CHARACTERS = 30_000

const HELD_CHARACTERS = MAX_OUTPUT_CHARACTERS * 2

const BINARY_SNIFF_BYTES = 8_000

const DEFAULT_TIMEOUT_SECONDS = 120

const MAX_TIMEOUT_SECONDS = 600

const STAT_CONCURRENCY = 32

const CONTEXT_LINES = 3

const ALWAYS_EXCLUDED = ['.git', 'node_modules', 'dist']

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

export class FileNotRead extends Schema.TaggedError<FileNotRead>()('FileNotRead', {
  path: Schema.String,
  reason: Schema.String,
}) {}

export class FileIsBinary extends Schema.TaggedError<FileIsBinary>()('FileIsBinary', {
  path: Schema.String,
  reason: Schema.String,
}) {}

export class CommandRefused extends Schema.TaggedError<CommandRefused>()('CommandRefused', {
  reason: Schema.String,
}) {}

export class CommandTimedOut extends Schema.TaggedError<CommandTimedOut>()('CommandTimedOut', {
  seconds: Schema.Int,
  output: Schema.String,
  reason: Schema.String,
}) {}

const Lines = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const Seconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

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

  const remaining = lines.length - from - selected.length

  const shown = clip(selected, budget)

  const notes = [
    shown.clipped ? `truncated at ${budget} characters` : undefined,
    remaining === 0
      ? undefined
      : `${remaining} more lines; continue with offset ${from + selected.length + 1}`,
  ].filter((note) => note !== undefined)

  const body = numbered(shown.lines, from + 1)

  return {
    complete: from === 0 && remaining === 0 && !shown.clipped,
    text: notes.length === 0 ? body : `${body}\n... (${notes.join('; ')})`,
  }
}

type Output = {
  readonly collect: (text: string) => Effect.Effect<void>
  // Renders what is left and flushes it to the spill file, so it is run once, on
  // whichever way the command ended.
  readonly seal: Effect.Effect<string>
}

// Keeps the end of a command's output, which is where the error usually is, and
// spills the whole of it to a file the model can go and read when it did not fit.
// The file outlives the call on purpose; the operating system clears it.
const makeOutput = (fs: FileSystem.FileSystem): Effect.Effect<Output> =>
  Effect.sync(() => {
    let held = ''
    let total = 0
    let spill: string | undefined
    let abandoned = false

    const store = (text: string): Effect.Effect<void> =>
      abandoned
        ? Effect.void
        : Effect.gen(function* () {
            spill ??= yield* fs.makeTempFile({ prefix: 'vody-bash-', suffix: '.log' })

            yield* fs.writeFileString(spill, text, { flag: 'a' })
          }).pipe(
            // A spill that failed part way would name a file that does not hold what it
            // claims, so stop spilling and stop naming it. Only the file system saying
            // no is handled: a defect or an interrupt belongs to whoever ran the command.
            Effect.catch((error) =>
              Effect.sync(() => {
                abandoned = true
              }).pipe(
                Effect.tap(() => Effect.logDebug(`bash gave up spilling output: ${error.message}`)),
              ),
            ),
          )

    const collect = (text: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        total += text.length

        held += text

        if (held.length <= HELD_CHARACTERS) {
          return
        }

        // Trim by character, not by chunk: a chunk can be larger than the whole tail,
        // and dropping one whole would leave far less than the tail that was promised.
        // Trimming to the budget only once it is doubled keeps the copying amortised.
        const excess = held.length - MAX_OUTPUT_CHARACTERS

        const dropped = held.slice(0, excess)

        held = held.slice(excess)

        yield* store(dropped)
      })

    const seal = Effect.gen(function* () {
      const shown = held.slice(Math.max(0, held.length - MAX_OUTPUT_CHARACTERS))

      const omitted = total - shown.length

      if (omitted === 0) {
        return shown === '' ? '(no output)' : shown
      }

      yield* store(held)

      const where = abandoned || spill === undefined ? '' : `; full output at ${spill}`

      return `... (${omitted} earlier characters omitted${where})\n${shown}`
    })

    return { collect, seal }
  })

const modifiedAt = (info: FileSystem.File.Info): number =>
  Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() })

const literalPrefix = (pattern: string): string => {
  const wildcard = pattern.search(/[*?[{]/)

  return wildcard === -1 ? pattern : pattern.slice(0, wildcard)
}

const reachesInto = (prefix: string, entry: string): boolean =>
  prefix === entry || prefix.startsWith(`${entry}/`)

const bash = Tool.make('bash', {
  description: [
    'Run a shell command. The first line of the result is `exit <code>`. The rest is the command',
    'output, stdout and stderr interleaved — except that output which ran long is cut from the',
    'front to keep the end, and then the line after `exit <code>` says how much went and names a',
    'file holding all of it, which you can read or grep. Each call starts a fresh shell, so `cd`',
    'and exported variables do not carry over — write `cd x && y` in one command instead. stdin is',
    'closed, so a command that would prompt reads end-of-file instead of hanging. The command is',
    `killed after timeout_seconds, ${DEFAULT_TIMEOUT_SECONDS} by default and at most ${MAX_TIMEOUT_SECONDS}.`,
  ].join(' '),
  parameters: Schema.Struct({
    command: Schema.String,
    timeout_seconds: Schema.optionalKey(Seconds),
  }),
  success: Schema.String,
  failure: Schema.Union([CommandRefused, CommandTimedOut]),
  failureMode: 'return',
})

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

const writeFile = Tool.make('write_file', {
  description: [
    'Write content to file, creating any missing parent directories. Writing over a file that',
    'already exists requires having read all of it first, so that what is replaced is known; a',
    'read that was cut short by offset, limit or the character budget does not count. To change',
    'part of a file, prefer edit_file, which needs no prior read.',
  ].join(' '),
  parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
  success: Schema.String,
  failure: Schema.Union([FileNotRead, FileSystemRefused]),
  failureMode: 'return',
})

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

const glob = Tool.make('glob', {
  description: [
    'Find files matching a glob pattern; ** matches recursively. Returns files only, most recently',
    'modified first, so the useful matches come first when the list is cut short. Anything',
    'gitignored is skipped, along with .git, node_modules and dist — unless the pattern names one',
    'of those directly.',
  ].join(' '),
  parameters: Schema.Struct({ pattern: Schema.String }),
  success: Schema.String,
  failure: FileSystemRefused,
  failureMode: 'return',
})

export const toolkit = Toolkit.make(bash, readFile, writeFile, editFile, glob)

export type Handlers = Tool.HandlersFor<(typeof toolkit)['tools']>

export const toolkitLayer: Layer.Layer<
  Handlers,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = toolkit.toLayer(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const root = yield* Workspace

    const seen = yield* Ref.make(new Map<string, number>())

    const remember = (resolved: string): Effect.Effect<void> =>
      fs.stat(resolved).pipe(
        Effect.flatMap((info) =>
          Ref.update(seen, (files) => new Map(files).set(resolved, modifiedAt(info))),
        ),
        Effect.ignore,
      )

    const writeAtomically = Effect.fn('writeAtomically')(function* (
      resolved: string,
      contents: string,
    ) {
      const directory = path.dirname(resolved)

      yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(refused))

      const suffix = yield* Random.nextInt

      const temporary = path.join(directory, `.${path.basename(resolved)}.${Math.abs(suffix)}.tmp`)

      yield* fs.writeFileString(temporary, contents).pipe(Effect.mapError(refused))

      yield* fs.rename(temporary, resolved).pipe(
        Effect.mapError(refused),
        Effect.tapCause(() => Effect.ignore(fs.remove(temporary, { force: true }))),
      )
    })

    const excludesFor = Effect.fn('excludesFor')(function* (pattern: string) {
      const listed = yield* spawner
        .string(
          ChildProcess.make(
            'git',
            ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
            { cwd: root },
          ),
        )
        .pipe(Effect.orElseSucceed(() => ''))

      const ignored = listed.split('\n').filter((entry) => entry !== '')

      const reachedInto = literalPrefix(pattern)

      return [...ALWAYS_EXCLUDED, ...ignored].flatMap((entry) => {
        const trimmed = entry.endsWith('/') ? entry.slice(0, -1) : entry

        return reachesInto(reachedInto, trimmed) ? [] : [trimmed, `${trimmed}/**`]
      })
    })

    return toolkit.of({
      bash: Effect.fn('bash')(function* ({ command, timeout_seconds: requested }) {
        yield* Console.log(`$ ${command}`)

        const seconds = Math.min(requested ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)

        const output = yield* makeOutput(fs)

        const run = Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make('sh', ['-c', command], {
                cwd: root,
                stdin: 'ignore',
                killSignal: 'SIGTERM',
                forceKillAfter: Duration.seconds(2),
              }),
            )

            yield* Stream.runForEach(Stream.decodeText(handle.all), output.collect)

            return yield* handle.exitCode
          }),
        ).pipe(
          Effect.mapError(
            (error) =>
              new CommandRefused({ reason: `bash could not run \`${command}\`: ${error.message}` }),
          ),
        )

        const code = yield* run.pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(seconds),
            orElse: () =>
              Effect.flatMap(output.seal, (shown) =>
                Effect.fail(
                  new CommandTimedOut({
                    seconds,
                    output: shown,
                    reason:
                      seconds === MAX_TIMEOUT_SECONDS
                        ? `bash killed \`${command}\` after ${seconds}s, the longest it will wait — narrow the work, or start it in the background if it is not meant to finish`
                        : `bash killed \`${command}\` after ${seconds}s — run it again with a longer timeout_seconds, or in the background if it is not meant to finish`,
                  }),
                ),
              ),
          }),
        )

        const shown = yield* output.seal

        yield* Console.log(shown.slice(0, PREVIEW_CHARACTERS))

        return `exit ${code}\n${shown}`
      }),

      read_file: Effect.fn('read_file')(function* ({ limit, offset, path: target }) {
        yield* Console.log(`read ${target}`)

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
          yield* remember(resolved)

          return '(empty file)'
        }

        const lines = toLines(contents)

        const from = (offset ?? 1) - 1

        if (from >= lines.length) {
          return `(offset ${offset ?? 1} is past the end of ${target}, which has ${lines.length} lines)`
        }

        const shown = view(lines, from, limit ?? DEFAULT_LINE_LIMIT, MAX_READ_CHARACTERS)

        if (shown.complete) {
          yield* remember(resolved)
        }

        return shown.text
      }),

      write_file: Effect.fn('write_file')(function* ({ content, path: target }) {
        yield* Console.log(`write ${target}`)

        const resolved = path.resolve(root, target)

        const existed = yield* fs.exists(resolved).pipe(Effect.mapError(refused))

        if (existed) {
          const info = yield* fs.stat(resolved).pipe(Effect.mapError(refused))

          const remembered = (yield* Ref.get(seen)).get(resolved)

          if (remembered === undefined || modifiedAt(info) > remembered) {
            return yield* new FileNotRead({
              path: target,
              reason:
                remembered === undefined
                  ? `write_file will not overwrite ${target} unseen — read_file all of it first, so the content it replaces is known`
                  : `write_file will not overwrite ${target}: it changed on disk after you read it — read_file it again before replacing it`,
            })
          }
        }

        yield* writeAtomically(resolved, content)

        yield* remember(resolved)

        const written = new TextEncoder().encode(content).length

        return `${existed ? 'Overwrote' : 'Created'} ${target} (${written} bytes)`
      }),

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

        yield* writeAtomically(resolved, mark + edited)

        yield* remember(resolved)

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

      glob: Effect.fn('glob')(function* ({ pattern }) {
        yield* Console.log(`glob ${pattern}`)

        const exclude = yield* excludesFor(pattern)

        const matches = yield* fs.glob(pattern, { exclude, root }).pipe(Effect.mapError(refused))

        const described = yield* Effect.forEach(
          matches,
          (match) =>
            fs.stat(path.resolve(root, match)).pipe(
              Effect.match({
                onFailure: () => [],
                onSuccess: (info) =>
                  info.type === 'File' ? [{ at: modifiedAt(info), path: match }] : [],
              }),
            ),
          { concurrency: STAT_CONCURRENCY },
        )

        const found = described
          .flat()
          .toSorted((left, right) => right.at - left.at || left.path.localeCompare(right.path))

        if (found.length === 0) {
          return '(no matches)'
        }

        const shown = found.slice(0, MAX_MATCHES).map((file) => file.path)

        return found.length > MAX_MATCHES
          ? [
              ...shown,
              `... (${found.length - MAX_MATCHES} more matches omitted, oldest first; narrow the pattern)`,
            ].join('\n')
          : shown.join('\n')
      }),
    })
  }),
)
