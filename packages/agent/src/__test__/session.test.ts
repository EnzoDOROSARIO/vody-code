import { afterEach, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { AiError } from 'effect/unstable/ai'

import { allowing } from './judging.ts'
import {
  brokenModel,
  judged,
  removeWorkspaces,
  scriptedModel,
  sessioned,
  workspace,
} from './testing.ts'

import type { Script } from './testing.ts'

afterEach(removeWorkspaces)

// A model that looks at a file and answers on the turn after.
const reading: Script = (turn) =>
  turn === 0
    ? [
        { type: 'text-delta', id: 'text-0', delta: 'let me look' },
        {
          type: 'tool-call',
          id: 'call-1',
          name: 'read_file',
          params: { path: 'inside/keep.txt' },
        },
      ]
    : [
        { type: 'text-delta', id: 'text-1', delta: 'kept, ' },
        { type: 'text-delta', id: 'text-1', delta: 'all of it' },
      ]

it.live('the session hands the Turn over to the callback, one Activity at a time, in order', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const [reply, call, result, ...fragments] = yield* sessioned(
      scriptedModel(reading),
      ['what is in the file'],
      judged(root, allowing),
    )

    expect(reply).toEqual({ id: 'text-0', text: 'let me look', type: 'reply' })
    expect(call).toEqual({
      id: 'call-1',
      name: 'read_file',
      params: { path: 'inside/keep.txt' },
      type: 'tool-call',
    })
    expect(result).toMatchObject({
      id: 'call-1',
      isFailure: false,
      name: 'read_file',
      result: expect.stringContaining('kept'),
      type: 'tool-result',
    })
    expect(fragments).toEqual([
      { id: 'text-1', text: 'kept, ', type: 'reply' },
      { id: 'text-1', text: 'all of it', type: 'reply' },
    ])
  }),
)

// The provider's own words about a call it refused to take, as a real failure of the
// model carries them: `module.method: <the reason's message>`.
const failure = AiError.make({
  method: 'streamText',
  module: 'OpenAI',
  reason: new AiError.RateLimitError({}),
})

// The call that breaks is the one after the tool ran, so the Turn is broken mid-way,
// with the fragments and the tool's result already handed over.
it.live('a model failure mid-Turn is reported as the Breakdown, and the ask resolves', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const activities = yield* sessioned(
      brokenModel(reading, 1, failure),
      ['what is in the file'],
      judged(root, allowing),
    )

    // Everything before the break was handed over as it happened, and the Breakdown is
    // the last thing the session said, after which nothing else is coming.
    expect(activities).toHaveLength(4)
    expect(activities.at(-1)).toEqual({ reason: failure.message, type: 'breakdown' })
    expect(activities.filter((activity) => activity.type === 'reply')).toEqual([
      { id: 'text-0', text: 'let me look', type: 'reply' },
    ])
    expect(activities.filter((activity) => activity.type === 'tool-result')).toMatchObject([
      { isFailure: false, name: 'read_file' },
    ])
  }),
)

// The ask is total: the Turn ended at a Breakdown, and the session's ask resolved with
// it reported. So the next question starts a Turn of its own, in the same conversation.
it.live('a Turn that ended at a Breakdown does not stop the session', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const activities = yield* sessioned(
      brokenModel(reading, 1, failure),
      ['what is in the file', 'and again'],
      judged(root, allowing),
    )

    // The second question's Turn ran whole: its fragments are the last things said.
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'all of it', type: 'reply' })
    expect(activities.filter((activity) => activity.type === 'breakdown')).toHaveLength(1)
  }),
)
