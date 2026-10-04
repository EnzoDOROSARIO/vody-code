import { Session } from 'agent'
import { Effect } from 'effect'
import { render } from 'ink'

import { App } from './app.tsx'

import type { Ask } from './app.tsx'

export const main: Effect.Effect<void, never, Session> = Effect.scoped(
  Effect.gen(function* () {
    const agent = yield* Session

    // The session hands back what it did; the App decides what any of it looks like. The
    // ask is total, so leaving the runtime as a promise hands over nothing: the Turn's
    // every ending is already an Activity the App was shown.
    // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- the ask is a promise the App holds, outside any fiber of this one
    const ask: Ask = (request, show) => Effect.runPromise(agent.ask(request, show))

    // The screen takes the alternate buffer, so the Composer stays on the last rows for
    // the whole session and leaving restores the screen that was there before. It is Ink
    // that enters the buffer and hides the cursor: the mount only asks for it.
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => render(<App ask={ask} />, { alternateScreen: true })),
      (mounted) => Effect.sync(() => mounted.unmount()),
    )

    yield* Effect.promise(() => app.waitUntilExit())
  }),
)
