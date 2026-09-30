import { afterEach, expect, test } from 'bun:test'
import { Effect, Option, Predicate, Queue } from 'effect'

import type { Layer, Schema } from 'effect'
import type { Toolkit } from 'effect/unstable/ai'

import { answering, judging, rejected } from './judging.ts'
import { judged, removeWorkspaces, workspace } from './testing.ts'
import { Request } from '#request.ts'
import { ActRefused, JudgeDidNotAnswer } from '#tools/index.ts'
import { call, outcome, run } from '#tools/__test__/harness.ts'

import type { Judge } from '#judge.ts'
import type { Tools } from '#tools/index.ts'

afterEach(removeWorkspaces)

type Answers = {
  readonly serves?: number
  readonly irreversible?: number
  readonly beyond?: number
  readonly sends?: number
}

// The Judge's answers about a command, question by question. An answer left out is 0,
// which for a danger is the safe side and for the alignment is the unrequested one.
const answers = ({ beyond = 0, irreversible = 0, sends = 0, serves = 0 }: Answers) =>
  answering(
    new Map([
      ['serves_request', serves],
      ['irreversible', irreversible],
      ['reaches_beyond_perimeter', beyond],
      ['sends_data_off_machine', sends],
    ]),
  )

const judgedAs = (given: Answers): Layer.Layer<Judge> => judging([answers(given)])

const running = (command: string) => (tools: Toolkit.WithHandler<Tools>) =>
  tools.handle('bash', { command })

const bash = (root: string, judge: Layer.Layer<Judge>, command: string) =>
  run(judged(root, judge), running(command))

test('an ordinary build or test command runs as it always did', async () => {
  const root = await workspace()

  const ran = await call(root, running('echo built && true'))

  expect(ran.isFailure).toBe(false)
  expect(ran.result).toBe('exit 0\nbuilt\n')
})

test('a destructive command that serves the Request runs', async () => {
  const root = await workspace()

  const ran = await bash(root, judgedAs({ serves: 0.9, irreversible: 0.9 }), 'rm inside/keep.txt')

  expect(ran.isFailure).toBe(false)
  expect(ran.result).toBe('exit 0\n(no output)')
  expect(await Bun.file(`${root}/inside/keep.txt`).exists()).toBe(false)
})

test('the same destructive command unrelated to the Request is refused, does not run, and says why', async () => {
  const root = await workspace()

  const ran = await bash(root, judgedAs({ serves: 0.1, irreversible: 0.9 }), 'rm inside/keep.txt')

  expect(ran.isFailure).toBe(true)
  expect(ran.result).toBeInstanceOf(ActRefused)
  // The refusal is the only account anyone gets of it, so it names the command as
  // written and every axis that tripped, with its answer and its line.
  expect(ran.result).toMatchObject({
    tripped: [
      { axis: 'serves_request', probability: 0.1, line: 'low', threshold: 0.3 },
      { axis: 'irreversible', probability: 0.9, line: 'high', threshold: 0.7 },
    ],
    reason:
      "bash will not run `rm inside/keep.txt`: the Judge's answers refuse it (serves_request at 0.1, below 0.3; irreversible at 0.9, at or above 0.7). The refusal is final, so do not run the same command again: do the work another way, or tell the person what you meant to run and why",
  })
  // What the model is handed is the refusal encoded, and it carries the same numbers.
  expect(Predicate.isTagged(ran.encodedResult, 'ActRefused')).toBe(true)
  expect(ran.encodedResult).toMatchObject({
    tripped: [
      { axis: 'serves_request', probability: 0.1, line: 'low', threshold: 0.3 },
      { axis: 'irreversible', probability: 0.9, line: 'high', threshold: 0.7 },
    ],
  })
  expect(await Bun.file(`${root}/inside/keep.txt`).text()).toBe('kept')
})

test('every danger that is high takes part in the refusal', async () => {
  const root = await workspace()

  const ran = await bash(
    root,
    judgedAs({ serves: 0, irreversible: 0.8, beyond: 0.8, sends: 0.8 }),
    'touch ran',
  )

  expect(ran.result).toMatchObject({
    tripped: [
      { axis: 'serves_request', probability: 0, line: 'low', threshold: 0.3 },
      { axis: 'irreversible', probability: 0.8, line: 'high', threshold: 0.7 },
      { axis: 'reaches_beyond_perimeter', probability: 0.8, line: 'high', threshold: 0.7 },
      { axis: 'sends_data_off_machine', probability: 0.8, line: 'high', threshold: 0.7 },
    ],
  })
  expect(await Bun.file(`${root}/ran`).exists()).toBe(false)
})

test('a command that sends data off the machine is refused above its band, however plainly it was asked for', async () => {
  const root = await workspace()

  const ran = await bash(root, judgedAs({ serves: 1, sends: 0.93 }), 'touch ran')

  expect(ran.isFailure).toBe(true)
  // Only the band tripped: the alignment was not low, so it took no part.
  expect(ran.result).toMatchObject({
    tripped: [
      { axis: 'sends_data_off_machine', probability: 0.93, line: 'absolute', threshold: 0.9 },
    ],
    reason: expect.stringContaining(
      '(sends_data_off_machine at 0.93, at or above the absolute band of 0.9)',
    ),
  })
  expect(await Bun.file(`${root}/ran`).exists()).toBe(false)
})

test('a command that cannot be undone is refused above its band, however plainly it was asked for', async () => {
  const root = await workspace()

  const ran = await bash(root, judgedAs({ serves: 1, irreversible: 0.97 }), 'touch ran')

  expect(ran.isFailure).toBe(true)
  expect(ran.result).toMatchObject({
    tripped: [{ axis: 'irreversible', probability: 0.97, line: 'absolute', threshold: 0.95 }],
  })
  expect(await Bun.file(`${root}/ran`).exists()).toBe(false)
})

test('a command that surely reaches beyond the Perimeter still runs when it was asked for', async () => {
  const root = await workspace()

  const ran = await bash(root, judgedAs({ serves: 1, beyond: 1 }), 'touch ran')

  expect(ran.isFailure).toBe(false)
  expect(await Bun.file(`${root}/ran`).exists()).toBe(true)
})

// Each line with an answer just below it, exactly on it, and just above it, decided both
// ways across the three: a comparison off by one flips exactly one. The alignment's line
// is crossed with a danger high enough to count, each danger's with an alignment low
// enough to let it, and each band's with an alignment as high as it goes.
const boundaries: ReadonlyArray<readonly [string, Answers, boolean]> = [
  ['an alignment just below its line refuses', { serves: 0.29, irreversible: 0.7 }, false],
  ['an alignment exactly on its line allows', { serves: 0.3, irreversible: 0.7 }, true],
  ['an alignment just above its line allows', { serves: 0.31, irreversible: 0.7 }, true],
  ['irreversibility just below high allows', { serves: 0.1, irreversible: 0.69 }, true],
  ['irreversibility exactly at high refuses', { serves: 0.1, irreversible: 0.7 }, false],
  ['irreversibility just above high refuses', { serves: 0.1, irreversible: 0.71 }, false],
  ['reaching beyond just below high allows', { serves: 0.1, beyond: 0.69 }, true],
  ['reaching beyond exactly at high refuses', { serves: 0.1, beyond: 0.7 }, false],
  ['reaching beyond just above high refuses', { serves: 0.1, beyond: 0.71 }, false],
  ['sending data just below high allows', { serves: 0.1, sends: 0.69 }, true],
  ['sending data exactly at high refuses', { serves: 0.1, sends: 0.7 }, false],
  ['sending data just above high refuses', { serves: 0.1, sends: 0.71 }, false],
  [
    'irreversibility just below its band allows what was asked',
    { serves: 1, irreversible: 0.94 },
    true,
  ],
  [
    'irreversibility exactly at its band refuses what was asked',
    { serves: 1, irreversible: 0.95 },
    false,
  ],
  [
    'irreversibility just above its band refuses what was asked',
    { serves: 1, irreversible: 0.96 },
    false,
  ],
  ['sending data just below its band allows what was asked', { serves: 1, sends: 0.89 }, true],
  ['sending data exactly at its band refuses what was asked', { serves: 1, sends: 0.9 }, false],
  ['sending data just above its band refuses what was asked', { serves: 1, sends: 0.91 }, false],
]

test.each(boundaries)('%s', async (_, given, allowed) => {
  const root = await workspace()

  const ran = await bash(root, judgedAs(given), 'touch ran')

  expect(ran.isFailure).toBe(!allowed)
  expect(await Bun.file(`${root}/ran`).exists()).toBe(allowed)
})

// Commands run in one program over one set of handlers, inside one Turn, with every
// question the Judge is asked noted as it arrives.
const judgedInOneTurn = (root: string, commands: ReadonlyArray<string>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked = yield* Queue.unbounded<Schema.Json>()

      const judge = judging([answers({ serves: 1 })], asked)

      const results = yield* Effect.forEach(commands, (command) => outcome(running(command))).pipe(
        Effect.provideService(Request, Option.some('build it, then test it')),
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
        Effect.provide(judged(root, judge)),
      )

      return { results, asked: yield* Queue.takeAll(asked) }
    }),
  )

test('a compound command reaches the Judge once, whole and unsplit', async () => {
  const root = await workspace()

  const command = 'echo one && echo two; echo three'

  const { asked, results } = await judgedInOneTurn(root, [command])

  expect(asked).toHaveLength(1)
  expect(asked[0]).toMatchObject({ command })
  expect(results[0]?.result).toBe('exit 0\none\ntwo\nthree\n')
})

test('the Judge is asked about every command, a repeat of one already judged included', async () => {
  const root = await workspace()

  const { asked } = await judgedInOneTurn(root, ['true', 'true', 'echo harmless'])

  expect(asked).toHaveLength(3)
  expect(asked).toMatchObject([
    { command: 'true' },
    { command: 'true' },
    { command: 'echo harmless' },
  ])
})

test('a Judge that does not answer refuses the command unjudged, and it does not run', async () => {
  const root = await workspace()

  const ran = await bash(root, judging([rejected]), 'touch ran')

  expect(ran.isFailure).toBe(true)
  expect(ran.result).toBeInstanceOf(JudgeDidNotAnswer)
  expect(ran.result).toMatchObject({ failure: 'CredentialsRejected' })
  expect(Predicate.isTagged(ran.encodedResult, 'JudgeDidNotAnswer')).toBe(true)
  expect(await Bun.file(`${root}/ran`).exists()).toBe(false)
})
