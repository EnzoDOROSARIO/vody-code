import { expect, it } from '@effect/vitest'
import { Effect, Predicate, Stream } from 'effect'
import type { Prompt, Response } from 'effect/unstable/ai'

import { rehearsed, scriptedModel } from './testing.ts'
import { ActRefused } from '#tools/index.ts'
import * as WritePlan from '#tools/write-plan.ts'

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

// One call of the model reaching for a tool that writes no Plan: the loop goes round
// again, and the Reminder's count has a call to count.
const look = (turn: number): Array<Part> => [
  {
    type: 'tool-call',
    id: `call-${turn}-look`,
    name: 'read_file',
    params: { path: 'inside/keep.txt' },
  },
]

// A `write_plan` call the schema refuses: two Steps in progress, so the handler never
// runs and the Plan it would have held is never written.
const malformed = (turn: number): Array<Part> => [
  {
    type: 'tool-call',
    id: `call-${turn}-plan`,
    name: 'write_plan',
    params: {
      steps: [
        { status: 'in_progress', text: 'one' },
        { status: 'in_progress', text: 'two' },
      ],
    },
  },
]

// A write past the working tree: refused by the seam below, which turns away every
// `write_file`, so none of them reaches the disk.
const refusedWrite = (turn: number, slot = 0): Array<Part> => [
  {
    type: 'tool-call',
    id: `call-${turn}-${slot}`,
    name: 'write_file',
    params: { content: 'hello', path: `../outside/${turn}-${slot}.txt` },
  },
]

const refusal = new ActRefused({
  reason: 'the Judge answered no',
  tripped: [{ axis: 'serves_request', line: 'low', probability: 0, threshold: 0.3 }],
})

// Every `write_file` is refused, so the writes above never happen. `write_plan` is not
// named because no Gate stands in front of it: the refusals tests' full play names it
// ungated, and this file plays only the refusal it needs.
const writesRefused: Hooks = { write_file: () => Effect.fail(refusal) }

// A model that writes the Plan the given way on each call of the model, one write per
// call, and answers when the writes run out.
const scripted =
  (writes: ReadonlyArray<ReadonlyArray<Step>>): Script =>
  (turn) => {
    const steps = writes[turn]

    return steps === undefined ? answer : write(turn, steps)
  }

// A model that reaches for one thing per call of the model, in the order given, and
// answers when the list runs out.
const turns =
  (calls: ReadonlyArray<(turn: number) => Array<Part>>): Script =>
  (turn) => {
    const call = calls[turn]

    return call === undefined ? answer : call(turn)
  }

// The prompts the model was sent, one per call of the model, alongside the script: the
// scripted model hands each script the prompt that call was sent, and a test that wants
// to see what the loop said to the model reads the last one.
const heard = (script: Script) => {
  const prompts: Array<Prompt.Prompt> = []

  return {
    prompts,
    script: (turn: number, prompt: Prompt.Prompt): Array<Part> => {
      prompts.push(prompt)

      return script(turn, prompt)
    },
  }
}

const reminders = (activities: ReadonlyArray<Activity>): Array<Activity> =>
  activities.filter((activity) => activity.type === 'reminder')

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

const STEPS: ReadonlyArray<Step> = [
  { status: 'completed', text: 'read the code' },
  { status: 'in_progress', text: 'change it' },
  { status: 'pending', text: 'run the tests' },
]

const OTHER: ReadonlyArray<Step> = [
  { status: 'pending', text: 'do the thing' },
  { status: 'in_progress', text: 'do the other thing' },
]

const COMPLETE: ReadonlyArray<Step> = [
  { status: 'completed', text: 'read the code' },
  { status: 'completed', text: 'change it' },
]

// The Reminder's words, pinned: said by the harness rather than the person, every Step
// with its status in the words `write_plan` taught, and the way out if the Plan no longer
// matches the work.
const REMINDER = [
  'Reminder from the harness: your Plan still has unfinished Steps. This is the Plan as you last wrote it:',
  '- read the code (completed)',
  '- change it (in_progress)',
  '- run the tests (pending)',
  'If the Plan no longer matches the work, write it again with write_plan.',
].join('\n')

it.live('an accepted write is reported as its call and acknowledged briefly', () =>
  Effect.gen(function* () {
    const activities = yield* rehearsed(scriptedModel(scripted([STEPS])), ['plan this'])

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
  }),
)

it.live('more than one Step in progress is refused, naming the rule', () =>
  Effect.gen(function* () {
    const activities = yield* rehearsed(scriptedModel(turns([malformed])), ['plan this'])

    expect(planFailure(activities)).toContain('Plan must have at most one step in progress')
    // A call the schema refused is not reported as a call at all: the refusal is the
    // only thing that arrives, as the tool's own failure.
    expect(activities.filter((activity) => activity.type === 'tool-call')).toEqual([])
  }),
)

it.live('a Step whose text is empty or whitespace only is refused, naming the rule', () =>
  Effect.gen(function* () {
    const activities = yield* rehearsed(
      scriptedModel(
        scripted([[{ status: 'pending', text: '' }], [{ status: 'pending', text: '   ' }]]),
      ),
      ['plan this'],
    )

    const failures = activities.filter(
      (activity) => activity.type === 'tool-result' && activity.isFailure,
    )

    expect(failures).toHaveLength(2)
    expect(planFailure(activities)).toContain('Step text must not be empty or whitespace only')
  }),
)

it.live('a Plan of more than 20 Steps is refused, and 20 are a Plan', () =>
  Effect.gen(function* () {
    const refused = yield* rehearsed(scriptedModel(scripted([many(21)])), ['plan this'])

    expect(planFailure(refused)).toContain('A Plan holds at most 20 steps')

    const accepted = yield* rehearsed(scriptedModel(scripted([many(20)])), ['plan this'])

    expect(accepted.filter((activity) => activity.type === 'tool-result')).toMatchObject([
      { isFailure: false, name: 'write_plan', result: 'Plan written' },
    ])
  }),
)

// A refused write leaves the Plan as it was: the Steps a later Reminder restates are the
// ones that were held, not the malformed ones the schema turned away.
it.live('a refused write leaves the Plan as it was', () =>
  Effect.gen(function* () {
    const { prompts, script } = heard(turns([(turn) => write(turn, STEPS), malformed, look, look]))

    const activities = yield* rehearsed(scriptedModel(script), ['plan this'])

    expect(planFailure(activities)).toContain('Plan must have at most one step in progress')
    expect(reminders(activities)).toEqual([{ steps: STEPS, type: 'reminder' }])
    expect(prompts.at(-1)?.content.at(-1)).toMatchObject({ content: REMINDER, role: 'system' })
  }),
)

// Writing the Plan is not an act at a Gate: it records no Passage, so a write between
// refusals leaves the count exactly where it was, and the Turn still reaches its Impasse
// at the third refusal.
it.live('a Plan write between Gate refusals does not clear the count', () =>
  Effect.gen(function* () {
    const activities = yield* rehearsed(
      scriptedModel(
        turns([refusedWrite, (turn) => write(turn, STEPS), refusedWrite, refusedWrite]),
      ),
      ['plan this'],
      writesRefused,
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
    const activities = yield* rehearsed(
      scriptedModel(turns([refusedWrite, malformed, refusedWrite])),
      ['plan this'],
      writesRefused,
    )

    expect(planFailure(activities)).toContain('Plan must have at most one step in progress')
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
  }),
)

// The count runs on the calls that reached for a tool: the write arms the Reminder, the
// three calls after it count up, and the fourth call — the continuation the Reminder
// bought — is sent the Plan as a system message, the harness speaking.
it.live(
  'a write, then three calls without writing, brings one Reminder and a prompt restating the Plan',
  () =>
    Effect.gen(function* () {
      const { prompts, script } = heard(turns([(turn) => write(turn, STEPS), look, look, look]))

      const activities = yield* rehearsed(scriptedModel(script), ['plan this'])

      expect(reminders(activities)).toEqual([{ steps: STEPS, type: 'reminder' }])
      // The Reminder buys exactly one more call of the model, and that call is sent the
      // Plan as the harness speaking: a system message at the end of the assembled prompt.
      expect(prompts).toHaveLength(5)
      expect(prompts.at(-1)?.content.at(-1)).toMatchObject({ content: REMINDER, role: 'system' })
    }),
)

// Two calls are not three: the Turn ends with its answer, and the loop never spoke.
it.live('a write, then two calls without writing, ends the Turn without a Reminder', () =>
  Effect.gen(function* () {
    const { prompts, script } = heard(turns([(turn) => write(turn, STEPS), look, look]))

    const activities = yield* rehearsed(scriptedModel(script), ['plan this'])

    expect(reminders(activities)).toEqual([])
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
    expect(
      prompts.every((prompt) => prompt.content.every((message) => message.role !== 'system')),
    ).toBe(true)
  }),
)

// At most one Reminder for each write: the calls after one has fired are left to work,
// however many of them there are.
it.live('further calls without writing after a Reminder bring no second one', () =>
  Effect.gen(function* () {
    const { script } = heard(
      turns([(turn) => write(turn, STEPS), look, look, look, look, look, look]),
    )

    const activities = yield* rehearsed(scriptedModel(script), ['plan this'])

    expect(reminders(activities)).toEqual([{ steps: STEPS, type: 'reminder' }])
  }),
)

// A new write is a new arming, and the Plan it leaves is the one the next Reminder
// restates: the write replaces the Plan whole.
it.live('a new write after a Reminder replaces the Plan and arms the Reminder again', () =>
  Effect.gen(function* () {
    const { script } = heard(
      turns([
        (turn) => write(turn, STEPS),
        look,
        look,
        look,
        (turn) => write(turn, OTHER),
        look,
        look,
        look,
      ]),
    )

    const activities = yield* rehearsed(scriptedModel(script), ['plan this'])

    expect(reminders(activities)).toEqual([
      { steps: STEPS, type: 'reminder' },
      { steps: OTHER, type: 'reminder' },
    ])
  }),
)

// A write in the same call as other tools is still a write: it resets the count the
// call was going to spend. Only two calls follow it, so no Reminder comes — where a
// count left standing would have reached three on the very call that wrote.
it.live('a write in the same call as other tools resets the count', () =>
  Effect.gen(function* () {
    const { script } = heard(
      turns([
        (turn) => write(turn, STEPS),
        look,
        look,
        (turn) => [...write(turn, OTHER), ...look(turn)],
        look,
        look,
      ]),
    )

    const activities = yield* rehearsed(scriptedModel(script), ['plan this'])

    expect(reminders(activities)).toEqual([])
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
  }),
)

// A Plan with every Step completed is not unfinished work: the Reminder stays quiet
// however long the Turn runs.
it.live('a Plan with every Step completed brings no Reminder, however many calls follow', () =>
  Effect.gen(function* () {
    const { script } = heard(turns([(turn) => write(turn, COMPLETE), look, look, look, look, look]))

    const activities = yield* rehearsed(scriptedModel(script), ['plan this'])

    expect(reminders(activities)).toEqual([])
  }),
)

// An empty write clears the Plan, and an empty Plan is nothing to remind the agent of.
it.live('an empty write is accepted and clears the Plan', () =>
  Effect.gen(function* () {
    const { script } = heard(
      turns([(turn) => write(turn, STEPS), (turn) => write(turn, []), look, look, look, look]),
    )

    const activities = yield* rehearsed(scriptedModel(script), ['plan this'])

    expect(
      activities.filter(
        (activity) => activity.type === 'tool-result' && activity.name === 'write_plan',
      ),
    ).toMatchObject([
      { isFailure: false, name: 'write_plan', result: 'Plan written' },
      { isFailure: false, name: 'write_plan', result: 'Plan written' },
    ])
    expect(reminders(activities)).toEqual([])
  }),
)

// A Plan left over from an earlier Turn is not this Turn's to remind: the holder is
// fresh, so only a write in the current Turn arms the Reminder.
it.live('a Plan written in an earlier Turn brings no Reminder in a later one', () =>
  Effect.gen(function* () {
    const { prompts, script } = heard(
      turns([(turn) => write(turn, STEPS), () => answer, look, look, look, look, look]),
    )

    const activities = yield* rehearsed(scriptedModel(script), ['plan this', 'and carry on'])

    expect(reminders(activities)).toEqual([])
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
    expect(
      prompts.every((prompt) => prompt.content.every((message) => message.role !== 'system')),
    ).toBe(true)
  }),
)

// A refused write is not a write: it cannot arm the Reminder, and an armed count counts
// it like any other call that did not write. Spending the one Reminder a write buys and
// then refusing a write shows both: a second Reminder would mean the refused write had
// armed the loop again.
it.live('a refused write neither arms the Reminder nor resets the count', () =>
  Effect.gen(function* () {
    const spent = heard(
      turns([(turn) => write(turn, STEPS), look, look, look, malformed, look, look, look]),
    )

    const activities = yield* rehearsed(scriptedModel(spent.script), ['plan this'])

    expect(reminders(activities)).toEqual([{ steps: STEPS, type: 'reminder' }])

    const armed = heard(turns([(turn) => write(turn, STEPS), look, malformed, look]))

    const carried = yield* rehearsed(scriptedModel(armed.script), ['plan this'])

    expect(reminders(carried)).toEqual([{ steps: STEPS, type: 'reminder' }])
  }),
)

// The Gates have the last word: a call that both spends the count and reaches an Impasse
// ends the Turn, with no Reminder after it.
it.live('an Impasse and a Reminder falling on the same call bring only the Impasse', () =>
  Effect.gen(function* () {
    const { script } = heard(
      turns([
        (turn) => write(turn, STEPS),
        look,
        look,
        (turn) => [...refusedWrite(turn, 0), ...refusedWrite(turn, 1), ...refusedWrite(turn, 2)],
      ]),
    )

    const activities = yield* rehearsed(scriptedModel(script), ['plan this'], writesRefused)

    expect(reminders(activities)).toEqual([])
    expect(activities.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
  }),
)

// The holder's default is total: with no Turn around it — a tool harness — the real
// handler still succeeds, its write recording into nothing.
it.live('outside a Turn the write_plan handler still succeeds', () =>
  Effect.gen(function* () {
    const results = yield* Stream.runCollect(
      Stream.unwrap(
        Effect.gen(function* () {
          const kit = yield* WritePlan.toolkit

          return yield* kit.handle('write_plan', { steps: STEPS })
        }),
      ),
    ).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
      Effect.provide(WritePlan.toolkit.toLayer({ write_plan: WritePlan.handler })),
    )

    expect(results.at(-1)).toMatchObject({ isFailure: false, result: 'Plan written' })
  }),
)
