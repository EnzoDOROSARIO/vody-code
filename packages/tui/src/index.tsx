import { Effect } from 'effect'
import { render } from 'ink'

import { App } from './app.tsx'

/**
 * The TUI program. Mounts the Ink app and completes once it unmounts, either
 * because the app exited or because the fiber was interrupted.
 *
 * Run it from an entrypoint with `BunRuntime.runMain`.
 */
export const main: Effect.Effect<void> = Effect.scoped(
  Effect.gen(function* () {
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => render(<App />)),
      (mounted) => Effect.sync(() => mounted.unmount()),
    )

    yield* Effect.promise(() => app.waitUntilExit())
  }),
)
