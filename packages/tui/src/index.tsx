import { answer, chat, toolkit } from 'agent'
import { Effect, Stream } from 'effect'

import type { Activity, Handlers } from 'agent'
import type { LanguageModel } from 'effect/unstable/ai'
import { render } from 'ink'

import { App } from './app.tsx'

import type { Ask } from './app.tsx'

export const main: Effect.Effect<void, never, Handlers | LanguageModel.LanguageModel> =
  Effect.scoped(
    Effect.gen(function* () {
      const tools = yield* toolkit
      const conversation = yield* chat

      const services = yield* Effect.context<Handlers | LanguageModel.LanguageModel>()

      // The agent hands back what it did; the App decides what any of it looks like.
      const ask: Ask = (question, show) =>
        Effect.runPromiseWith(services)(
          Stream.runForEach(answer(conversation, tools, question), (activity: Activity) =>
            Effect.sync(() => show(activity)),
          ),
        )

      const app = yield* Effect.acquireRelease(
        Effect.sync(() => render(<App ask={ask} />)),
        (mounted) => Effect.sync(() => mounted.unmount()),
      )

      yield* Effect.promise(() => app.waitUntilExit())
    }),
  )
