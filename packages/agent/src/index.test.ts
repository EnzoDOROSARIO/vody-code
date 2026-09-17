import { BunServices } from '@effect/platform-bun'
import { expect, test } from 'bun:test'
import { Effect, Layer, Ref, Stream } from 'effect'
import { TestConsole } from 'effect/testing'
import { Chat, LanguageModel, Prompt } from 'effect/unstable/ai'
import type { Response, Tool } from 'effect/unstable/ai'

import { answer, toolkit, toolkitLayer } from './index.ts'

/** Turn 0 asks for a command; every turn after it answers. */
const scriptedParts = (turn: number): Array<Response.PartEncoded> =>
  turn === 0
    ? [{ type: 'tool-call', id: 'call-1', name: 'bash', params: { command: 'echo hi' } }]
    : [{ type: 'text', text: 'it printed hi' }]

/**
 * A model that asks for one `bash` command and then, having been shown its
 * output, answers. Two turns is the smallest script that makes the loop go
 * around and then stop.
 */
const scriptedModel = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const turns = yield* Ref.make(0)

    return yield* LanguageModel.make({
      generateText: () =>
        Effect.map(
          Ref.getAndUpdate(turns, (turn) => turn + 1),
          scriptedParts,
        ),
      streamText: () => Stream.empty,
    })
  }),
)

const layer = Layer.mergeAll(scriptedModel, toolkitLayer, TestConsole.layer).pipe(
  Layer.provideMerge(BunServices.layer),
)

/** Everything the scripted layer above supplies to a test. */
type Provided =
  | BunServices.BunServices
  | LanguageModel.LanguageModel
  | TestConsole.TestConsole
  | Tool.Handler<'bash'>

/** Each test is its own entry point, with a fresh scripted model and chat. */
const run = <A, E>(program: Effect.Effect<A, E, Provided>): Promise<A> =>
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
  Effect.runPromise(program.pipe(Effect.provide(layer)))

test('the loop runs the tool the model asks for, then returns its answer', async () => {
  const outcome = await run(
    Effect.gen(function* () {
      const tools = yield* toolkit
      const chat = yield* Chat.fromPrompt(Prompt.empty)

      const reply = yield* answer(chat, tools, 'say hi')
      const printed = yield* TestConsole.logLines

      return { printed, reply }
    }),
  )

  expect(outcome.reply).toBe('it printed hi')
  expect(outcome.printed).toEqual(['$ echo hi', 'hi\n'])
})

test('the loop stops on a turn with no tool call', async () => {
  const reply = await run(
    Effect.gen(function* () {
      const tools = yield* toolkit
      const chat = yield* Chat.fromPrompt(Prompt.empty)

      // The scripted model spends its tool-calling turn here, so the second
      // question sees a model that answers straight away.
      yield* answer(chat, tools, 'say hi')

      return yield* answer(chat, tools, 'and again')
    }),
  )

  expect(reply).toBe('it printed hi')
})
