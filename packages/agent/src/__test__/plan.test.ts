import { expect, it } from '@effect/vitest'
import { Effect, Predicate } from 'effect'
import type { Response } from 'effect/unstable/ai'

import { rehearsed, scriptedModel } from './testing.ts'
import { ActRefused } from '#tools/index.ts'
import { Plan, fresh } from '#tools/plan.ts'

import type { Script } from './testing.ts'
import type { Activity } from '#activity.ts'
import type { Hooks } from '#tools/index.ts'
import type { Step } from '#tools/plan.ts'

type Part = Response.StreamPartEncoded

const answer: Array<Part> = [{ type: 'text-delta', id: 'text-1', delta: 'done' }]

// One call of the model reaching for `write_plan` with the Steps given.
const write = (turn: number, steps: ReadonlyArray<Step>): Array<Part> => [
  { type: 'tool-call', id: `call-${turn}`, name: 'write_plan', params: { steps } },
]

// A model that writes the Plan the given way on each call of the model, one write per
// call, and answers when the writes run out.
const scripted =
  (writes: ReadonlyArray<ReadonlyArray<Step>>): Script =>
  (turn) => {
    const steps = writes[turn]

    return steps === undefined ? answer : write(turn, steps)
  }

const STEPS: ReadonlyArray<Step> = [
  { status: 'completed', text: 'read the code' },
  { status: 'in_progress', text: 'change it' },
  { status: 'pending', text: 'run the tests' },
]

const OTHER: ReadonlyArray<Step> = [
  { status: 'pending', text: 'do the thing' },
  { status: 'in_progress', text: 'do the other thing' },
]

// The Turn's holder, fresh for this test, provided around the whole Turn so the real
// `write_plan` handler stores into it: the spec's shape, minus the loop that reads it.
const planned = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<{ readonly activities: A; readonly plan: Plan }, E, R> =>
  Effect.gen(function* () {
    const plan = yield* fresh

    return { activities: yield* effect.pipe(Effect.provideService(Plan, plan)), plan }
  })

it.live('an accepted write is reported as its call, acknowledged briefly, and held', () =>
  Effect.gen(function* () {
    const { activities, plan } = yield* planned(
      rehearsed(scriptedModel(scripted([STEPS])), ['plan this']),
    )

    const [call, result] = activities

    expect(call).toEqual({
      id: 'call-0',
      name: 'write_plan',
      params: { steps: STEPS },
      type: 'tool-call',
    })
    expect(result).toMatchObject({
      isFailure: false,
      name: 'write_plan',
      result: 'Plan written',
      type: 'tool-result',
    })
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
    expect(yield* plan.written).toEqual({ steps: STEPS, writes: 1 })
  }),
)

it.live('a later write replaces the Plan whole', () =>
  Effect.gen(function* () {
    const { activities, plan } = yield* planned(
      rehearsed(scriptedModel(scripted([STEPS, OTHER])), ['plan this']),
    )

    expect(activities.filter((activity) => activity.type === 'tool-result')).toHaveLength(2)
    expect(yield* plan.written).toEqual({ steps: OTHER, writes: 2 })
  }),
)

it.live('an empty write is accepted and clears the Plan', () =>
  Effect.gen(function* () {
    const { activities, plan } = yield* planned(
      rehearsed(scriptedModel(scripted([STEPS, []])), ['plan this']),
    )

    expect(activities.filter((activity) => activity.type === 'tool-result')).toMatchObject([
      { isFailure: false, name: 'write_plan', result: 'Plan written' },
      { isFailure: false, name: 'write_plan', result: 'Plan written' },
    ])
    expect(yield* plan.written).toEqual({ steps: [], writes: 2 })
  }),
)

// The failed `write_plan` result among the activities: a refused call comes back as the
// tool's own failure, so the reason is where the rule is named.
const planFailure = (activities: ReadonlyArray<Activity>): string => {
  const result = activities.find(
    (activity) =>
      activity.type === 'tool-result' && activity.name === 'write_plan' && activity.isFailure,
  )

  if (result === undefined) {
    throw new Error('expected a failed write_plan result')
  }

  return Predicate.isTagged(result.result, 'AiError') ? result.result.message : ''
}

const many = (count: number): ReadonlyArray<Step> =>
  Array.from({ length: count }, (_value, index): Step => ({
    status: 'pending',
    text: `step ${index + 1}`,
  }))

it.live('more than one Step in progress is refused, naming the rule', () =>
  Effect.gen(function* () {
    const { activities, plan } = yield* planned(
      rehearsed(
        scriptedModel(
          scripted([
            [
              { status: 'in_progress', text: 'one' },
              { status: 'in_progress', text: 'two' },
            ],
          ]),
        ),
        ['plan this'],
      ),
    )

    expect(planFailure(activities)).toContain('Plan must have at most one step in progress')
    // A call the schema refused is not reported as a call at all: the refusal is the
    // only thing that arrives, as the tool's own failure.
    expect(activities.filter((activity) => activity.type === 'tool-call')).toEqual([])
    expect(yield* plan.written).toEqual({ steps: [], writes: 0 })
  }),
)

it.live('a Step whose text is empty or whitespace only is refused, naming the rule', () =>
  Effect.gen(function* () {
    const { activities, plan } = yield* planned(
      rehearsed(
        scriptedModel(
          scripted([[{ status: 'pending', text: '' }], [{ status: 'pending', text: '   ' }]]),
        ),
        ['plan this'],
      ),
    )

    const failures = activities.filter(
      (activity) => activity.type === 'tool-result' && activity.isFailure,
    )

    expect(failures).toHaveLength(2)
    expect(planFailure(activities)).toContain('Step text must not be empty or whitespace only')
    expect(yield* plan.written).toEqual({ steps: [], writes: 0 })
  }),
)

it.live('a Plan of more than 20 Steps is refused, and 20 are a Plan', () =>
  Effect.gen(function* () {
    const refused = yield* planned(rehearsed(scriptedModel(scripted([many(21)])), ['plan this']))

    expect(planFailure(refused.activities)).toContain('A Plan holds at most 20 steps')
    expect(yield* refused.plan.written).toEqual({ steps: [], writes: 0 })

    const accepted = yield* planned(rehearsed(scriptedModel(scripted([many(20)])), ['plan this']))

    expect(yield* accepted.plan.written).toEqual({ steps: many(20), writes: 1 })
  }),
)

it.live('a refused write leaves the Plan as it was', () =>
  Effect.gen(function* () {
    const { activities, plan } = yield* planned(
      rehearsed(
        scriptedModel(
          scripted([
            STEPS,
            [
              { status: 'in_progress', text: 'one' },
              { status: 'in_progress', text: 'two' },
            ],
          ]),
        ),
        ['plan this'],
      ),
    )

    expect(planFailure(activities)).toContain('Plan must have at most one step in progress')
    expect(yield* plan.written).toEqual({ steps: STEPS, writes: 1 })
  }),
)

// A model that reaches for one thing per call of the model, in the order given, and
// answers when the list runs out.
const turns =
  (calls: ReadonlyArray<(turn: number) => Array<Part>>): Script =>
  (turn) => {
    const call = calls[turn]

    return call === undefined ? answer : call(turn)
  }

// A write past the working tree, which the write Gate refuses: the same play the
// refusals tests use, with `write_plan` named as ungated beside it.
const refusedWrite = (turn: number): Array<Part> => [
  {
    type: 'tool-call',
    id: `call-${turn}`,
    name: 'write_file',
    params: { content: 'hello', path: `../outside/${turn}.txt` },
  },
]

const refusal = new ActRefused({
  reason: 'the Judge answered no',
  tripped: [{ axis: 'serves_request', line: 'low', probability: 0, threshold: 0.3 }],
})

const outsideRefused: Hooks = { write_file: () => Effect.fail(refusal) }

// Writing the Plan is not an act at a Gate: it records no Passage, so a write between
// refusals leaves the count exactly where it was, and the Turn still reaches its Impasse
// at the third refusal.
it.live('a Plan write between Gate refusals does not clear the count', () =>
  Effect.gen(function* () {
    const { activities } = yield* planned(
      rehearsed(
        scriptedModel(
          turns([refusedWrite, (turn) => write(turn, STEPS), refusedWrite, refusedWrite]),
        ),
        ['plan this'],
        outsideRefused,
      ),
    )

    expect(activities.filter((activity) => activity.type === 'tool-call')).toHaveLength(4)
    expect(activities.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
  }),
)

// A schema refusal is `write_plan`'s own failure, not a Gate's answer, so it never adds
// to the count: two Gate refusals with a refused write between them still leave the Turn
// short of an Impasse, and the model answers.
it.live('a refused Plan write never counts toward an Impasse', () =>
  Effect.gen(function* () {
    const { activities } = yield* planned(
      rehearsed(
        scriptedModel(
          turns([
            refusedWrite,
            (turn) =>
              write(turn, [
                { status: 'in_progress', text: 'one' },
                { status: 'in_progress', text: 'two' },
              ]),
            refusedWrite,
          ]),
        ),
        ['plan this'],
        outsideRefused,
      ),
    )

    expect(planFailure(activities)).toContain('Plan must have at most one step in progress')
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
  }),
)

// The holder's default is total: a handler run with no Turn around it — a tool harness —
// succeeds without failing for want of a Turn, and its write records into nothing.
it.live('outside a Turn the Plan holds nothing and a write records into nothing', () =>
  Effect.gen(function* () {
    const plan = yield* Plan

    expect(yield* plan.written).toEqual({ steps: [], writes: 0 })

    yield* plan.write([{ status: 'pending', text: 'not held' }])

    expect(yield* plan.written).toEqual({ steps: [], writes: 0 })
  }),
)
