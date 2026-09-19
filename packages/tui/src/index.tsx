import { answer, chat, toolkit } from 'agent'
import { Console, Effect } from 'effect'
import type { LanguageModel, Tool } from 'effect/unstable/ai'
import { render } from 'ink'

import { App } from './app.tsx'

import type { Ask } from './app.tsx'

/**
 * Sends the agent's own output to the view instead of stdout, which Ink owns
 * while it is mounted. This is how the `$ ` lines for each command reach the
 * transcript without the agent knowing there is a TUI.
 */
const writingTo = (write: (line: string) => void): Console.Console =>
  Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<string>) => write(args.join(' ')),
  })

/**
 * The TUI. Mounts the Ink app and completes once it unmounts, either because
 * the app exited or because the fiber was interrupted.
 *
 * Run it from an entrypoint with `BunRuntime.runMain`.
 */
export const main: Effect.Effect<void, never, LanguageModel.LanguageModel | Tool.Handler<'bash'>> =
  Effect.scoped(
    Effect.gen(function* () {
      const tools = yield* toolkit
      const conversation = yield* chat

      // Captured so that each question the view asks runs with the same model and
      // tool handlers this program was given.
      const services = yield* Effect.context<LanguageModel.LanguageModel | Tool.Handler<'bash'>>()

      const ask: Ask = (question, write) =>
        Effect.runPromiseWith(services)(
          answer(conversation, tools, question).pipe(
            Effect.provideService(Console.Console, writingTo(write)),
          ),
        )

      const app = yield* Effect.acquireRelease(
        Effect.sync(() => render(<App ask={ask} />)),
        (mounted) => Effect.sync(() => mounted.unmount()),
      )

      yield* Effect.promise(() => app.waitUntilExit())
    }),
  )
