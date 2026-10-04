import { expect, it } from '@effect/vitest'
import { Effect, Predicate } from 'effect'
import type { Response } from 'effect/ai'

import { rehearsed, scriptedModel } from './testing.ts'

import type { SkillNotFound } from '#tools/index.ts'
import type { Skill } from '#catalog.ts'
import type { Activity } from '#activity.ts'
import type { Script } from './testing.ts'

type Part = Response.StreamPartEncoded

const answer: Array<Part> = [{ type: 'text-delta', id: 'text-1', delta: 'done' }]

// One call of the model reaching for `load_skill` by the name the Catalog lists.
const load = (turn: number, name: string, slot = 0): Array<Part> => [
  { type: 'tool-call', id: `call-${turn}-${slot}`, name: 'load_skill', params: { name } },
]

// A model that reaches for one thing per call of the model, in the order given, and
// answers when the list runs out.
const turns =
  (calls: ReadonlyArray<(turn: number) => Array<Part>>): Script =>
  (turn) =>
    calls[turn]?.(turn) ?? answer

// The startup copy `load_skill` serves: what a session would have read from disk, held
// in memory, with the frontmatter already left behind.
const catalog = (...skills: ReadonlyArray<readonly [string, Skill]>): ReadonlyMap<string, Skill> =>
  new Map(skills)

const TDD: Skill = {
  body: 'Write the test first.\nThen the code.',
  description: 'Does TDD work',
  path: '/skills/tdd',
}

const ZEBRA: Skill = {
  body: 'Zebra.',
  description: 'Does zebra work',
  path: '/skills/zebra',
}

const ALPACA: Skill = {
  body: 'Not the one you asked for.',
  description: 'Another Skill',
  path: '/skills/alpaca',
}

// The failed `load_skill` result among the activities, narrowed: a load's own failure
// comes back as a tagged result, so its `reason` is where the correction is named.
const refusal = (activities: ReadonlyArray<Activity>): SkillNotFound => {
  const found = activities.find(
    (activity) =>
      activity.type === 'tool-result' && activity.name === 'load_skill' && activity.isFailure,
  )

  if (found === undefined || !found.isFailure) {
    throw new Error('expected a failed load_skill result')
  }

  if (!Predicate.isTagged(found.result, 'SkillNotFound')) {
    throw new Error('the load did not fail with a SkillNotFound')
  }

  return found.result
}

const successes = (activities: ReadonlyArray<Activity>): Array<Activity> =>
  activities.filter(
    (activity) =>
      activity.type === 'tool-result' && activity.name === 'load_skill' && !activity.isFailure,
  )

it.live("a name the schema refuses comes back as the tool's own parameter failure", () =>
  Effect.gen(function* () {
    const activities = yield* rehearsed(
      scriptedModel(
        turns([
          () => [{ type: 'tool-call', id: 'call-0-0', name: 'load_skill', params: { name: 42 } }],
        ]),
      ),
      ['load the Skill'],
      {},
      {},
      catalog(['tdd', TDD]),
    )

    const failed = activities.find(
      (activity) =>
        activity.type === 'tool-result' && activity.name === 'load_skill' && activity.isFailure,
    )

    if (failed === undefined || !failed.isFailure) {
      throw new Error('expected a failed load_skill result')
    }

    if (!Predicate.isTagged(failed.result, 'AiError')) {
      throw new Error('the load was not refused by its parameter schema')
    }

    // A call the schema refused is not reported as a call at all: the parameter decode
    // happens before the tool-call Activity is built, so the refusal is all that arrives.
    expect(activities.filter((activity) => activity.type === 'tool-call')).toEqual([])
    expect(failed.result.message).toContain("Invalid parameters for tool 'load_skill'")
  }),
)

it.live('a load is reported as its call and returns the body under the Skill folder', () =>
  Effect.gen(function* () {
    const activities = yield* rehearsed(
      scriptedModel(turns([(turn) => load(turn, 'tdd')])),
      ['load the Skill'],
      {},
      {},
      catalog(['tdd', TDD]),
    )

    const [call, result] = activities

    expect(call).toEqual({
      id: 'call-0-0',
      name: 'load_skill',
      params: { name: 'tdd' },
      type: 'tool-call',
    })
    expect(result).toMatchObject({
      isFailure: false,
      name: 'load_skill',
      result:
        '<skill name="tdd" path="/skills/tdd">\nWrite the test first.\nThen the code.\n</skill>',
      type: 'tool-result',
    })
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
  }),
)

it.live('an unknown name fails, naming the name it did not find and listing the names', () =>
  Effect.gen(function* () {
    const activities = yield* rehearsed(
      scriptedModel(turns([(turn) => load(turn, 'missing')])),
      ['load the Skill'],
      {},
      {},
      catalog(['zebra', ZEBRA], ['alpaca', ALPACA]),
    )

    const reason = refusal(activities).reason

    expect(reason).toContain('"missing"')
    // Sorted, not the order the Catalog was built in: the same correction every time.
    expect(reason).toContain('alpaca, zebra')
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
  }),
)

it.live('an empty Catalog fails, saying there are no Skills', () =>
  Effect.gen(function* () {
    const activities = yield* rehearsed(scriptedModel(turns([(turn) => load(turn, 'anything')])), [
      'load the Skill',
    ])

    const stopped = refusal(activities)

    expect(Predicate.isTagged(stopped, 'SkillNotFound')).toBe(true)
    expect(stopped.name).toBe('anything')
    expect(stopped.reason).toContain('no Skills')
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
  }),
)

it.live('the same Skill loads twice, both times in full', () =>
  Effect.gen(function* () {
    const activities = yield* rehearsed(
      scriptedModel(turns([(turn) => load(turn, 'tdd'), (turn) => load(turn, 'tdd')])),
      ['load the Skill'],
      {},
      {},
      catalog(['tdd', TDD]),
    )

    expect(successes(activities)).toMatchObject([
      {
        isFailure: false,
        result:
          '<skill name="tdd" path="/skills/tdd">\nWrite the test first.\nThen the code.\n</skill>',
      },
      {
        isFailure: false,
        result:
          '<skill name="tdd" path="/skills/tdd">\nWrite the test first.\nThen the code.\n</skill>',
      },
    ])
  }),
)
