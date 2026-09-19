import { answer, chat, toolkit } from 'agent'
import { Console, Effect } from 'effect'

import type { Handlers } from 'agent'
import type { LanguageModel } from 'effect/unstable/ai'
import { render } from 'ink'

import { App } from './app.tsx'

import type { Ask } from './app.tsx'

const writingTo = (write: (line: string) => void): Console.Console =>
  Object.assign(Object.create(console), {
    log: (...args: ReadonlyArray<string>) => write(args.join(' ')),
  })

export const main: Effect.Effect<void, never, Handlers | LanguageModel.LanguageModel> =
  Effect.scoped(
    Effect.gen(function* () {
      const tools = yield* toolkit
      const conversation = yield* chat

      const services = yield* Effect.context<Handlers | LanguageModel.LanguageModel>()

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
