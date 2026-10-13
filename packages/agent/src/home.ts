import { Config, Context, Effect, FileSystem, Layer, Option, Path } from 'effect'

/**
 * The person's home directory, by the rules the port owns: the real path when HOME
 * resolves, the normalised name when it does not exist yet, and none when HOME is
 * unset. A required port rather than an ambient reference, so a missing provision is a
 * compile error at composition instead of whichever directory HOME happened to name at
 * runtime.
 */
export class Home extends Context.Service<Home, Option.Option<string>>()('agent/Home') {
  static readonly layer: Layer.Layer<Home, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
    Home,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      // The home directory by its real path, since that is the form a landing path is
      // in. One that cannot be resolved does not exist yet, and a write can still
      // create it, so its name is kept, normalised the way a real path is, so that a
      // trailing slash or a `..` in HOME does not hide the writes under it. With no
      // HOME at all, nothing is under a home.
      return yield* Effect.option(Config.String('HOME')).pipe(
        Effect.map(
          Option.map((named) =>
            fs.realPath(named).pipe(Effect.orElseSucceed(() => path.resolve(named))),
          ),
        ),
        Effect.flatMap(Effect.transposeOption),
      )
    }),
  )
}
