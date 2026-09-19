import { Context, Effect, FileSystem, Layer, Option, Path, Random, Ref } from 'effect'

import { refused } from './errors.ts'

import type { FileSystemRefused } from './errors.ts'

export const modifiedAt = (info: FileSystem.File.Info): number =>
  Option.match(info.mtime, { onNone: () => 0, onSome: (at) => at.getTime() })

// How the file tools touch the workspace, and what they remember of it. The record
// of what has been read is shared: read_file fills it and write_file spends it, so
// a tool holding its own copy would license nothing, or everything.
export class Files extends Context.Service<
  Files,
  {
    // Write to a sibling and rename over the target, so an interrupted write leaves
    // the original whole.
    readonly write: (resolved: string, contents: string) => Effect.Effect<void, FileSystemRefused>
    readonly remember: (resolved: string) => Effect.Effect<void>
    // When the file was last modified as of the read that saw all of it, or undefined
    // for a file no read has shown whole.
    readonly rememberedAt: (resolved: string) => Effect.Effect<number | undefined>
  }
>()('agent/tools/Files') {
  static readonly layer: Layer.Layer<Files, never, FileSystem.FileSystem | Path.Path> =
    Layer.effect(
      Files,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const seen = yield* Ref.make(new Map<string, number>())

        const remember = (resolved: string): Effect.Effect<void> =>
          fs.stat(resolved).pipe(
            Effect.flatMap((info) =>
              Ref.update(seen, (files) => new Map(files).set(resolved, modifiedAt(info))),
            ),
            Effect.ignore,
          )

        const rememberedAt = (resolved: string): Effect.Effect<number | undefined> =>
          Effect.map(Ref.get(seen), (files) => files.get(resolved))

        const write = Effect.fn('Files.write')(function* (resolved: string, contents: string) {
          const directory = path.dirname(resolved)

          yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(refused))

          const suffix = yield* Random.nextInt

          const temporary = path.join(
            directory,
            `.${path.basename(resolved)}.${Math.abs(suffix)}.tmp`,
          )

          yield* fs.writeFileString(temporary, contents).pipe(Effect.mapError(refused))

          yield* fs.rename(temporary, resolved).pipe(
            Effect.mapError(refused),
            Effect.tapCause(() => Effect.ignore(fs.remove(temporary, { force: true }))),
          )
        })

        return Files.of({ remember, rememberedAt, write })
      }),
    )
}
