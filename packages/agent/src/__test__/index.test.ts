import { expect, test } from 'bun:test'
import { Effect, Layer, Ref, Stream } from 'effect'
import { TestConsole } from 'effect/testing'
import { Chat, LanguageModel, Prompt } from 'effect/unstable/ai'
import type { Response } from 'effect/unstable/ai'

import type { BunServices } from '@effect/platform-bun'

import { answer } from '../index.ts'
import { services } from './testing.ts'
import { toolkit } from '../tools/index.ts'

import type { Handlers } from '../tools/index.ts'

const scriptedParts = (turn: number): Array<Response.StreamPartEncoded> =>
  turn === 0
    ? [{ type: 'tool-call', id: 'call-1', name: 'bash', params: { command: 'echo hi' } }]
    : [
        { type: 'text-delta', id: 'text-1', delta: 'it printed ' },
        { type: 'text-delta', id: 'text-1', delta: 'hi' },
      ]

const scriptedModel = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const turns = yield* Ref.make(0)

    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.unwrap(
          Effect.map(
            Ref.getAndUpdate(turns, (turn) => turn + 1),
            (turn) => Stream.fromIterable(scriptedParts(turn)),
          ),
        ),
    })
  }),
)

const layer = Layer.mergeAll(scriptedModel, services(process.cwd()))

type Provided =
  | BunServices.BunServices
  | LanguageModel.LanguageModel
  | Handlers
  | TestConsole.TestConsole

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

      yield* answer(chat, tools, 'say hi')

      return yield* answer(chat, tools, 'and again')
    }),
  )

  expect(reply).toBe('it printed hi')
})
