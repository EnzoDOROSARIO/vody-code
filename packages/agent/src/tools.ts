import { Console, Effect, FileSystem, Path, Schema } from 'effect'

import type { Layer, PlatformError } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { Workspace } from './workspace.ts'

const MAX_MATCHES = 200

const PREVIEW_CHARACTERS = 200

export class FileSystemRefused extends Schema.TaggedError<FileSystemRefused>()(
  'FileSystemRefused',
  { reason: Schema.String },
) {}

export class TextNotFound extends Schema.TaggedError<TextNotFound>()('TextNotFound', {
  path: Schema.String,
  reason: Schema.String,
}) {}

const refused = (error: PlatformError.PlatformError): FileSystemRefused =>
  new FileSystemRefused({ reason: error.message })

const Lines = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const bash = Tool.make('bash', {
  description: 'Run a shell command.',
  parameters: Schema.Struct({ command: Schema.String }),
  success: Schema.String,
})

const readFile = Tool.make('read_file', {
  description: 'Read file contents, stopping after `limit` lines when one is given.',
  parameters: Schema.Struct({ path: Schema.String, limit: Schema.optionalKey(Lines) }),
  success: Schema.String,
  failure: FileSystemRefused,
  failureMode: 'return',
})

const writeFile = Tool.make('write_file', {
  description: 'Write content to file, creating any missing parent directories.',
  parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
  success: Schema.String,
  failure: FileSystemRefused,
  failureMode: 'return',
})

const editFile = Tool.make('edit_file', {
  description: 'Replace text in file once, at its first occurrence.',
  parameters: Schema.Struct({
    path: Schema.String,
    old_text: Schema.String,
    new_text: Schema.String,
  }),
  success: Schema.String,
  failure: Schema.Union([TextNotFound, FileSystemRefused]),
  failureMode: 'return',
})

const glob = Tool.make('glob', {
  description: 'Find files matching a glob pattern; ** matches recursively.',
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

    return toolkit.of({
      bash: Effect.fn('bash')(function* ({ command }) {
        yield* Console.log(`$ ${command}`)

        const output = yield* spawner
          .string(ChildProcess.make('sh', ['-c', command], { cwd: root }), {
            includeStderr: true,
          })
          .pipe(Effect.orDie)

        yield* Console.log(output.slice(0, PREVIEW_CHARACTERS))

        return output
      }),

      read_file: Effect.fn('read_file')(function* ({ limit, path: target }) {
        yield* Console.log(`read ${target}`)

        const resolved = path.resolve(root, target)

        const contents = yield* fs.readFileString(resolved).pipe(Effect.mapError(refused))

        if (limit === undefined) {
          return contents
        }

        const split = contents.split('\n')
        const lines = split.at(-1) === '' ? split.slice(0, -1) : split

        return lines.length <= limit
          ? contents
          : [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join('\n')
      }),

      write_file: Effect.fn('write_file')(function* ({ content, path: target }) {
        yield* Console.log(`write ${target}`)

        const resolved = path.resolve(root, target)

        yield* fs
          .makeDirectory(path.dirname(resolved), { recursive: true })
          .pipe(Effect.mapError(refused))

        yield* fs.writeFileString(resolved, content).pipe(Effect.mapError(refused))

        const written = new TextEncoder().encode(content).length

        return `Wrote ${written} bytes to ${target}`
      }),

      edit_file: Effect.fn('edit_file')(function* ({
        new_text: replacement,
        old_text: original,
        path: target,
      }) {
        yield* Console.log(`edit ${target}`)

        const resolved = path.resolve(root, target)

        const contents = yield* fs.readFileString(resolved).pipe(Effect.mapError(refused))

        const at = contents.indexOf(original)

        if (at === -1) {
          return yield* new TextNotFound({
            path: target,
            reason: `edit_file found no occurrence of old_text in ${target} — read the file and retry with text copied from it`,
          })
        }

        const edited = contents.slice(0, at) + replacement + contents.slice(at + original.length)

        yield* fs.writeFileString(resolved, edited).pipe(Effect.mapError(refused))

        return `Edited ${target}`
      }),

      glob: Effect.fn('glob')(function* ({ pattern }) {
        yield* Console.log(`glob ${pattern}`)

        const matches = yield* fs.glob(pattern, { root }).pipe(Effect.mapError(refused))

        const found = matches.toSorted()

        if (found.length === 0) {
          return '(no matches)'
        }

        return found.length > MAX_MATCHES
          ? [...found.slice(0, MAX_MATCHES), '... (more matches omitted; narrow the pattern)'].join(
              '\n',
            )
          : found.join('\n')
      }),
    })
  }),
)
