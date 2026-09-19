import { Console, Effect, FileSystem, Path, Schema } from 'effect'

import type { Layer } from 'effect'
import { Tool, Toolkit } from 'effect/unstable/ai'

import { FileSystemRefused, refused } from './errors.ts'
import { Files, modifiedAt } from './files.ts'
import { Workspace } from '../workspace.ts'

export class FileNotRead extends Schema.TaggedError<FileNotRead>()('FileNotRead', {
  path: Schema.String,
  reason: Schema.String,
}) {}

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

export const toolkit: Toolkit.Toolkit<{ readonly write_file: typeof writeFile }> =
  Toolkit.make(writeFile)

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
      write_file: Effect.fn('write_file')(function* ({ content, path: target }) {
        yield* Console.log(`write ${target}`)

        const resolved = path.resolve(root, target)

        const existed = yield* fs.exists(resolved).pipe(Effect.mapError(refused))

        if (existed) {
          const info = yield* fs.stat(resolved).pipe(Effect.mapError(refused))

          const remembered = yield* files.rememberedAt(resolved)

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

        yield* files.write(resolved, content)

        yield* files.remember(resolved)

        const written = new TextEncoder().encode(content).length

        return `${existed ? 'Overwrote' : 'Created'} ${target} (${written} bytes)`
      }),
    })
  }),
)
