import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { Response } from 'effect/ai'

import { rehearsed, scriptedModel } from './testing.ts'
import { ActRefused, JudgeDidNotAnswer, TextNotFound } from '#tools/index.ts'

import type { Script } from './testing.ts'
import type { Activity } from '#activity.ts'
import type { Skill } from '#catalog.ts'
import type { Call, Hook, Hooks, Tools } from '#tools/index.ts'
import type { Handler } from '#tools/hooks.ts'

// What a Gate's answer looks like at the seam the loop reads: a failure the tool has
// declared, which the counting reads by tag and nothing else about it matters. A test
// plays one of these at the seam for whichever acts it has opinions about; every tool
// with no hook in the play runs its can.
const refusal = new ActRefused({
  reason: 'the Judge answered no',
  tripped: [{ axis: 'serves_request', line: 'low', probability: 0, threshold: 0.3 }],
})

const unanswered = new JudgeDidNotAnswer({
  failure: 'Other',
  reason: 'the play of a Judge that answered nothing',
})

/** A whole seam, played: a hook for every tool a Gate stands in front of, and `undefined`
 * for the tools none does — the shape `gates.ts` builds, so a new tool is a compile error
 * here until the play says which side of the line it is on. */
type Play = { readonly [Name in keyof Tools]: Hook<Name> | undefined }

// The write Gate's rule, played in for both tools it stands in front of: the writes
// outside the working tree are refused, and the ones inside go without asking, as the
// real one lets a write inside the Perimeter pass unjudged.
const outsideRefused = ({
  params,
}: Call<'edit_file' | 'write_file'>): Effect.Effect<void, ActRefused> =>
  params.path.startsWith('../outside') ? Effect.fail(refusal) : Effect.void

// The seam the following tests play with: both tools of the write Gate behind its own
// rule, and the command Gate letting every command through. A tool with no hook here —
// read_file, glob, load_skill — is not gated, which is the seam's to say and no longer
// the loop's.
const writesOutsideRefused = {
  bash: () => Effect.void,
  edit_file: outsideRefused,
  glob: undefined,
  load_skill: undefined,
  read_file: undefined,
  write_file: outsideRefused,
  write_plan: undefined,
} satisfies Play

// The command Gate's answer on one question, played in full: a command the Judge reads
// as irreversible is refused however it was asked for.
const commandsRefused: Hooks = {
  bash: () => Effect.fail(refusal),
}

// The first act judged and refused, every act after it refused with no answer at all:
// what the real Gates and Judge give when the Judge limps back one mistake and stops.
const judgedOnce: Hooks = (() => {
  let judged = 0

  return {
    write_file: () => {
      judged += 1

      return judged === 1 ? Effect.fail(refusal) : Effect.fail(unanswered)
    },
  }
})()

type Part = Response.StreamPartEncoded

// Every step is its own call of the model, so a step's number is the model's turn, and
// `slot` tells apart the calls one step makes together. Every argument any of these
// steps passes is a string.
const call = (
  turn: number,
  slot: number,
  name: string,
  params: Readonly<Record<string, string>>,
): Array<Part> => [{ type: 'tool-call', id: `call-${turn}-${slot}`, name, params }]

/** A write past the root, acted as if outside the working tree. */
const writeOutside = (turn: number, slot: number): Array<Part> =>
  call(turn, slot, 'write_file', { path: `../outside/${turn}-${slot}.txt`, content: 'hello' })

const writeInside = (turn: number, slot: number): Array<Part> =>
  call(turn, slot, 'write_file', { path: `inside/${turn}-${slot}.txt`, content: 'hello' })

const editInside = (turn: number, slot: number): Array<Part> =>
  call(turn, slot, 'edit_file', { path: 'inside/file.txt', old_text: 'kept', new_text: 'kept' })

const editMissing = (turn: number, slot: number): Array<Part> =>
  call(turn, slot, 'edit_file', { path: 'inside/file.txt', old_text: 'absent', new_text: 'x' })

const run = (turn: number, slot: number): Array<Part> =>
  call(turn, slot, 'bash', { command: 'echo hi' })

const read = (turn: number, slot: number): Array<Part> =>
  call(turn, slot, 'read_file', { path: 'inside/file.txt' })

const search = (turn: number, slot: number): Array<Part> =>
  call(turn, slot, 'glob', { pattern: '**/*.txt' })

const load = (turn: number, slot: number): Array<Part> =>
  call(turn, slot, 'load_skill', { name: 'tdd' })

const loadMissing = (turn: number, slot: number): Array<Part> =>
  call(turn, slot, 'load_skill', { name: 'absent' })

// The in-memory Catalog a load reads: no Skills unless a test says otherwise, so no test
// here touches the workspace's own `.agents/skills/`.
const CATALOG: ReadonlyMap<string, Skill> = new Map([
  ['tdd', { body: 'Write the test first.', description: 'Does TDD work', path: '/skills/tdd' }],
])

const answer: Array<Part> = [{ type: 'text-delta', id: 'text-1', delta: 'done' }]

type Move = (turn: number, slot: number) => Array<Part>

// A model that takes `moves` one call of the model at a time and then answers. However
// long the list, it answers in the end, so a loop with no cap finishes too, just with more
// calls in it.
const scripted =
  (moves: ReadonlyArray<Move>): Script =>
  (turn) =>
    moves[turn]?.(turn, 0) ?? answer

// One move that reaches for several tools at once, as a model does when it asks for them
// in parallel: the tools run concurrently, and their results come back in whatever order
// they finish.
const together =
  (...moves: ReadonlyArray<Move>): Move =>
  (turn) =>
    moves.flatMap((move, slot) => move(turn, slot))

const repeated = (move: Move, times: number): ReadonlyArray<Move> =>
  Array.from({ length: times }, () => move)

// An edit whose old text is simply not in the file: what a real edit_file says when
// nothing matches, which is the tool's mistake and not any Gate's answer. Played the
// way it happens: the Gate in front of the edit passes, and the tool itself then fails.
const missingEdit: Hooks = { ...writesOutsideRefused, edit_file: () => Effect.void }

const noMatch: Handler<'edit_file'> = ({ old_text: sought, path: target }) =>
  sought === 'kept'
    ? Effect.succeed('the file is the way the edit left it')
    : Effect.fail(new TextNotFound({ path: target, reason: 'nothing matches it' }))

const talk = (
  moves: ReadonlyArray<Move>,
  hooks: Hooks = {},
  requests: ReadonlyArray<string> = ['tidy up'],
  answers: Partial<{ readonly [Name in keyof Tools]: Handler<Name> }> = {},
  catalog: ReadonlyMap<string, Skill> = new Map(),
): Effect.Effect<Array<Activity>> =>
  rehearsed(scriptedModel(scripted(moves)), requests, hooks, answers, catalog)

const calls = (activities: ReadonlyArray<Activity>): number =>
  activities.filter((activity) => activity.type === 'tool-call').length

it.live('a model that keeps writing outside is stopped after the third refusal', () =>
  Effect.gen(function* () {
    const activities = yield* talk(repeated(writeOutside, 10), writesOutsideRefused)

    expect(calls(activities)).toBe(3)
    expect(activities.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
  }),
)

const closed = (activities: ReadonlyArray<Activity>): boolean =>
  activities.some((activity) => activity.type === 'impasse')

// The count is exactly what the comparison bounds, so a line one out either way shows
// here: two refusals leave the Turn going, and the model answers as it meant to.
it.live('two refusals leave the Turn going to its answer', () =>
  Effect.gen(function* () {
    const activities = yield* talk(repeated(writeOutside, 2), writesOutsideRefused)

    expect(calls(activities)).toBe(2)
    expect(closed(activities)).toBe(false)
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
  }),
)

// Nothing follows the report: no fourth call, and no reply the model never gave.
it.live('the end of a Turn by refusal is its last Activity', () =>
  Effect.gen(function* () {
    const activities = yield* talk(repeated(writeOutside, 10), writesOutsideRefused)

    expect(activities.filter((activity) => activity.type === 'impasse')).toHaveLength(1)
    expect(activities.filter((activity) => activity.type === 'reply')).toEqual([])
    expect(activities.filter((activity) => activity.type === 'tool-result')).toMatchObject([
      { isFailure: true, name: 'write_file' },
      { isFailure: true, name: 'write_file' },
      { isFailure: true, name: 'write_file' },
    ])
  }),
)

// Each gated tool, allowed, between pairs of refusals: a write inside, which no Judge is
// asked about, an edit inside, and a command the Judge let run. Eight refusals in all,
// never three since the last act that went through.
it.live('an allowed gated act clears the count', () =>
  Effect.gen(function* () {
    const twice = repeated(writeOutside, 2)

    const activities = yield* talk(
      [...twice, writeInside, ...twice, editInside, ...twice, run, ...twice],
      writesOutsideRefused,
    )

    expect(calls(activities)).toBe(11)
    expect(closed(activities)).toBe(false)
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
  }),
)

// Reading and searching always succeed. A model that looks around between attempts is
// still being refused, and the third refusal ends the Turn with the looking in between.
it.live('a successful read or search does not clear the count', () =>
  Effect.gen(function* () {
    const activities = yield* talk(
      [writeOutside, read, writeOutside, search, writeOutside, read],
      writesOutsideRefused,
    )

    expect(calls(activities)).toBe(5)
    expect(activities.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
  }),
)

// A Skill load reads the Catalog and touches nothing, so no Gate stands in front of it:
// loads between attempts are like reading and searching, and the third refusal ends the
// Turn with them in between, at the same count.
it.live('a successful Skill load does not clear the count', () =>
  Effect.gen(function* () {
    const activities = yield* talk(
      [writeOutside, load, writeOutside, load, writeOutside, load],
      writesOutsideRefused,
      ['tidy up'],
      {},
      CATALOG,
    )

    expect(calls(activities)).toBe(5)
    expect(activities.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
  }),
)

// A load that failed is `load_skill`'s own answer, not a Gate's: it neither counts as a
// refusal nor, having done nothing, as an act allowed through.
it.live('a load that failed neither counts nor clears', () =>
  Effect.gen(function* () {
    const twice = repeated(writeOutside, 2)

    const counted = yield* talk(
      [...twice, loadMissing, writeInside],
      writesOutsideRefused,
      ['tidy up'],
      {},
      CATALOG,
    )

    const cleared = yield* talk(
      [...twice, loadMissing, writeOutside, writeInside],
      writesOutsideRefused,
      ['tidy up'],
      {},
      CATALOG,
    )

    expect(closed(counted)).toBe(false)
    expect(counted.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
    expect(calls(cleared)).toBe(4)
    expect(cleared.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
  }),
)

// A passage belongs to one call of the model, not the Turn: the write that got through
// in the first call must not clear the count three calls later, when the only act
// between the refusals is a read.
it.live('a passage clears one call of the model, not the whole Turn', () =>
  Effect.gen(function* () {
    const activities = yield* talk(
      [writeInside, writeOutside, read, writeOutside, writeOutside],
      writesOutsideRefused,
    )

    expect(calls(activities)).toBe(5)
    expect(activities.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
  }),
)

// An edit that matched nothing is the model's mistake, not the Gate's answer: it neither
// counts as a refusal nor, having done nothing, as an act allowed through.
it.live('a gated tool that failed on its own neither counts nor clears', () =>
  Effect.gen(function* () {
    const twice = repeated(writeOutside, 2)

    const counted = yield* talk([...twice, editMissing, writeInside], missingEdit, ['tidy up'], {
      edit_file: noMatch,
    })

    const cleared = yield* talk(
      [...twice, editMissing, writeOutside, writeInside],
      missingEdit,
      ['tidy up'],
      { edit_file: noMatch },
    )

    expect(closed(counted)).toBe(false)
    expect(calls(cleared)).toBe(4)
    expect(cleared.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
  }),
)

// A long Turn that brushes the Gate twice, far apart, is doing its work and carries on.
it.live('a Turn doing useful work through one or two refusals answers as normal', () =>
  Effect.gen(function* () {
    const activities = yield* talk(
      [
        read,
        search,
        writeInside,
        writeOutside,
        editInside,
        read,
        run,
        writeOutside,
        writeInside,
        read,
      ],
      writesOutsideRefused,
    )

    expect(calls(activities)).toBe(10)
    expect(closed(activities)).toBe(false)
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
  }),
)

it.live('a model that keeps running a refused command is stopped after the third refusal', () =>
  Effect.gen(function* () {
    const activities = yield* talk(repeated(run, 10), commandsRefused)

    expect(calls(activities)).toBe(3)
    expect(activities.filter((activity) => activity.type === 'tool-result')).toMatchObject([
      { isFailure: true, name: 'bash', result: expect.any(ActRefused) },
      { isFailure: true, name: 'bash', result: expect.any(ActRefused) },
      { isFailure: true, name: 'bash', result: expect.any(ActRefused) },
    ])
    expect(activities.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
  }),
)

// A Judge that refuses the first write it is asked about and then stops answering: one
// judged refusal, then two refused unjudged, and the three together end the Turn.
it.live('refusals because the Judge did not answer count alongside judged ones', () =>
  Effect.gen(function* () {
    const activities = yield* talk(repeated(writeOutside, 10), judgedOnce)

    const failures = activities.flatMap((activity) =>
      activity.type === 'tool-result' && activity.isFailure ? [activity.result] : [],
    )

    expect(failures).toEqual([
      expect.any(ActRefused),
      expect.any(JudgeDidNotAnswer),
      expect.any(JudgeDidNotAnswer),
    ])
    expect(activities.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
  }),
)

// Two refusals in one Turn and two in the next are two Turns each short of the cap. The
// model's turns run on across Requests, so the second Request's steps follow the
// first's answer in the script.
it.live('each Turn counts its refusals from none', () =>
  Effect.gen(function* () {
    const twice = repeated(writeOutside, 2)

    const activities = yield* talk([...twice, () => answer, ...twice], writesOutsideRefused, [
      'tidy up',
      'and again',
    ])

    expect(calls(activities)).toBe(4)
    expect(closed(activities)).toBe(false)
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
  }),
)

// One call of the model that reaches for four refused writes at once passes the cap in a
// single step, and the Impasse carries the count that ran out, not the cap it passed.
it.live('several refusals in one step all count, and the Impasse says how many', () =>
  Effect.gen(function* () {
    const activities = yield* talk([together(...repeated(writeOutside, 4))], writesOutsideRefused)

    expect(calls(activities)).toBe(4)
    expect(activities.at(-1)).toEqual({ refusals: 4, type: 'impasse' })
  }),
)

// Calls made together saw none of each other's results, so an allowed act among them
// comes between nothing: a step that was refused anything adds to the count, whatever
// else in it went through. The write inside is never judged, so it finishes first or
// last depending on where it sits, and the outcome is the same either way.
it.live('an allowed act in a step that was also refused does not clear the count', () =>
  Effect.gen(function* () {
    const before = yield* talk(
      [writeOutside, together(writeInside, writeOutside), writeOutside],
      writesOutsideRefused,
    )

    const after = yield* talk(
      [writeOutside, together(writeOutside, writeInside), writeOutside],
      writesOutsideRefused,
    )

    expect(calls(before)).toBe(4)
    expect(before.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
    expect(calls(after)).toBe(4)
    expect(after.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
  }),
)

// A step whose gated acts all went through clears the count, however many it made.
it.live('a step that got every gated act through clears the count', () =>
  Effect.gen(function* () {
    const twice = repeated(writeOutside, 2)

    const activities = yield* talk(
      [...twice, together(writeInside, editInside), ...twice],
      writesOutsideRefused,
    )

    expect(calls(activities)).toBe(6)
    expect(closed(activities)).toBe(false)
    expect(activities.at(-1)).toEqual({ id: 'text-1', text: 'done', type: 'reply' })
  }),
)

// A provider streams a call's arguments ahead of the call itself, each fragment naming
// the tool it is for. An edit that matched nothing, streamed that way, has still done
// nothing: its arguments arriving say nothing about the Gate, so the third refusal after
// it ends the Turn just as it does when the call arrives whole.
const streamedEditMissing = (turn: number, slot: number): Array<Part> => {
  const id = `call-${turn}-${slot}`
  const params = { path: 'inside/file.txt', old_text: 'absent', new_text: 'x' }

  return [
    { type: 'tool-params-start', id, name: 'edit_file' },
    { type: 'tool-params-delta', id, delta: JSON.stringify(params) },
    { type: 'tool-params-end', id },
    { type: 'tool-call', id, name: 'edit_file', params },
  ]
}

it.live('a gated call streamed in fragments is not an act allowed through', () =>
  Effect.gen(function* () {
    const twice = repeated(writeOutside, 2)

    const activities = yield* talk(
      [...twice, streamedEditMissing, writeOutside, writeInside],
      missingEdit,
      ['tidy up'],
      { edit_file: noMatch },
    )

    expect(calls(activities)).toBe(4)
    expect(activities.at(-1)).toEqual({ refusals: 3, type: 'impasse' })
  }),
)
