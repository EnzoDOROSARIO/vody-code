import { expect, test } from 'bun:test'
import { Effect, Layer, Ref, Stream } from 'effect'
import { Chat, LanguageModel, Prompt } from 'effect/unstable/ai'
import type { Response } from 'effect/unstable/ai'

import type { BunServices } from '@effect/platform-bun'

import { answer } from '#index.ts'
import { services } from './testing.ts'
import { toolkit } from '#tools/index.ts'

import type { Activity } from '#activity.ts'
import type { Handlers } from '#tools/index.ts'

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

type Provided = BunServices.BunServices | LanguageModel.LanguageModel | Handlers

const run = <A, E>(program: Effect.Effect<A, E, Provided>): Promise<A> =>
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
  Effect.runPromise(program.pipe(Effect.provide(layer)))

const asking = (...questions: ReadonlyArray<string>): Promise<Array<Activity>> =>
  run(
    Effect.gen(function* () {
      const tools = yield* toolkit
      const chat = yield* Chat.fromPrompt(Prompt.empty)

      const seen: Array<Activity> = []

      for (const question of questions) {
        yield* Stream.runForEach(answer(chat, tools, question), (activity) =>
          Effect.sync(() => {
            seen.push(activity)
          }),
        )
      }

      return seen
    }),
  )

test('the loop runs the tool the model asks for, then reports its answer', async () => {
  const [call, result, reply] = await asking('say hi')

  expect(call).toMatchObject({
    name: 'bash',
    params: { command: 'echo hi' },
    type: 'tool-call',
  })
  expect(result).toMatchObject({ isFailure: false, name: 'bash', type: 'tool-result' })
  expect(reply).toEqual({ type: 'reply', text: 'it printed hi' })
})

test('a bash call arrives typed, not as an anonymous payload', async () => {
  const [call] = await asking('say hi')

  if (call?.type !== 'tool-call' || call.name !== 'bash') {
    throw new Error(`expected a bash call, got ${String(call?.type)}`)
  }

  // The annotation is the assertion. A streamed tool call carries its arguments as
  // `unknown`, and they are a command again only because the agent parses them back.
  const command: string = call.params.command

  expect(command).toBe('echo hi')
})

test('the loop stops on a turn with no tool call', async () => {
  const activities = await asking('say hi', 'and again')

  expect(activities.filter((activity) => activity.type === 'reply')).toEqual([
    { type: 'reply', text: 'it printed hi' },
    { type: 'reply', text: 'it printed hi' },
  ])
})
