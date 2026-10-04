import { expect, it } from '@effect/vitest'
import { Effect, Option } from 'effect'
import type { Response } from 'effect/ai'

import { Request } from '#request.ts'
import { rehearsed, scriptedModel } from './testing.ts'

import type { Script } from './testing.ts'

const answered: Array<Response.StreamPartEncoded> = [
  { type: 'text-delta', id: 'text-1', delta: 'done' },
]

const reaching: Array<Response.StreamPartEncoded> = [
  { type: 'tool-call', id: 'call-1', name: 'bash', params: { command: 'true' } },
]

// A model that reaches for `bash` on the first call of every Turn and answers on the
// second, so each Turn runs the tool exactly once.
const once: Script = (turn) => (turn % 2 === 0 ? reaching : answered)

// A model that reaches for `bash` twice before answering: the second call runs in the
// continuation the agent starts to hand the first result back.
const twice: Script = (turn) => (turn === 2 ? answered : reaching)

// Put each Request to the agent in one conversation, with a hook at the seam that
// notes what it read as the Request before `bash` runs. What comes back is one reading
// per call, in the order the calls ran. The seam is where the Gates will stand in the
// agent as mounted, so what the hook reads here is the same words those Gates will be
// handed.
const heard = (
  script: Script,
  requests: ReadonlyArray<string>,
): Effect.Effect<Array<Option.Option<string>>> => {
  const seen: Array<Option.Option<string>> = []

  return rehearsed(scriptedModel(script), requests, {
    bash: () =>
      Effect.gen(function* () {
        seen.push(yield* Request)
      }),
  }).pipe(Effect.map(() => seen))
}

it('outside any Turn there is no request', () => {
  expect(Effect.runSync(Request)).toEqual(Option.none())
})

it.live('a hook before a tool reads the request that started the Turn', () =>
  Effect.gen(function* () {
    expect(yield* heard(once, ['say hi'])).toEqual([Option.some('say hi')])
  }),
)

it.live('the request is still there on the continuation that carries a result back', () =>
  Effect.gen(function* () {
    expect(yield* heard(twice, ['say hi'])).toEqual([Option.some('say hi'), Option.some('say hi')])
  }),
)

it.live('a new request replaces the last one', () =>
  Effect.gen(function* () {
    expect(yield* heard(once, ['say hi', 'now wave'])).toEqual([
      Option.some('say hi'),
      Option.some('now wave'),
    ])
  }),
)
