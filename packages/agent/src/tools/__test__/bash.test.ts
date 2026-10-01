import { afterEach, expect, it } from '@effect/vitest'
import { Effect, FileSystem } from 'effect'
import * as Fs from 'node:fs/promises'

import { call, text } from './harness.ts'
import { onDisk, readText, removeWorkspaces, workspace } from '#__test__/testing.ts'

import type { Outcome } from './harness.ts'
import { CommandRefused, CommandTimedOut } from '#tools/index.ts'
import { MAX_TIMEOUT_SECONDS, timedOut } from '#tools/bash.ts'

afterEach(removeWorkspaces)

const spillOf = (result: Outcome): string => {
  const named = /full output at (?<at>\S+?)\)/u.exec(text(result))?.groups?.['at']

  if (named === undefined) {
    throw new Error(`no spill file named in: ${text(result).slice(0, 120)}`)
  }

  return named
}

it.live('bash runs in the workspace and reports a clean exit', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const outcome = yield* call(root, (tools) =>
      tools.handle('bash', { command: 'cat inside/keep.txt' }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(outcome.result).toBe('exit 0\nkept')
  }),
)

it.live('bash reports a command that failed', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const outcome = yield* call(root, (tools) =>
      tools.handle('bash', { command: 'echo trouble; exit 3' }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(outcome.result).toBe('exit 3\ntrouble\n')
  }),
)

it.live('bash includes what a command wrote to stderr', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const outcome = yield* call(root, (tools) =>
      tools.handle('bash', { command: 'echo complaint >&2' }),
    )

    expect(outcome.result).toBe('exit 0\ncomplaint\n')
  }),
)

it.live('bash marks a command that printed nothing', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const outcome = yield* call(root, (tools) => tools.handle('bash', { command: 'true' }))

    expect(outcome.result).toBe('exit 0\n(no output)')
  }),
)

it.live('bash closes stdin, so a command that reads it ends instead of hanging', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const outcome = yield* call(root, (tools) => tools.handle('bash', { command: 'cat' }))

    expect(outcome.result).toBe('exit 0\n(no output)')
  }),
)

it.live('bash kills a command that outstays its timeout, keeping what it printed', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const outcome = yield* call(root, (tools) =>
      tools.handle('bash', { command: 'echo starting; sleep 30', timeout_seconds: 1 }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(CommandTimedOut)
    expect(outcome.result).toMatchObject({ output: 'starting\n', seconds: 1 })
    // A timeout the caller chose can be raised; the ceiling cannot, and the two say so
    // differently.
    expect(outcome.result).toMatchObject({
      reason: expect.stringContaining('run it again with a longer timeout_seconds'),
    })
  }),
)

// The ceiling arm cannot be reached through the tool — getting there means asking for
// the ceiling and then waiting it out — so the sentence is checked where it is written.
it('a command killed at the ceiling is not told to ask for longer', () => {
  const ceiling = timedOut('sleep 999', MAX_TIMEOUT_SECONDS)

  expect(ceiling).toContain('the longest it will wait')
  expect(ceiling).not.toContain('timeout_seconds')
  expect(timedOut('sleep 999', 1)).toContain('run it again with a longer timeout_seconds')
})

it.live('bash keeps the end of output that would otherwise flood the context', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const outcome = yield* call(root, (tools) =>
      tools.handle('bash', { command: `seq 1 20000; echo done` }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(text(outcome.result).endsWith('done\n')).toBe(true)
    expect(text(outcome.result)).toContain('earlier characters omitted')
    expect(text(outcome.result).length).toBeLessThan(31_200)
  }),
)

it.live('bash writes the whole of a truncated output to a file it names', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const outcome = yield* call(root, (tools) =>
      tools.handle('bash', { command: `seq 1 20000; echo done` }),
    )

    const whole = yield* Effect.promise(() => readText(spillOf(outcome.result)))

    expect(whole.startsWith('1\n2\n3\n')).toBe(true)
    expect(whole.endsWith('20000\ndone\n')).toBe(true)
  }),
)

it.live('bash keeps a whole tail even when one chunk is larger than the tail', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    // A single line far longer than the budget arrives in chunks bigger than the tail
    // itself, so trimming a whole chunk at a time would leave almost nothing behind.
    const outcome = yield* call(root, (tools) =>
      tools.handle('bash', { command: `head -c 400000 /dev/zero | tr '\\0' 'x'; echo done` }),
    )

    expect(text(outcome.result).endsWith('done\n')).toBe(true)
    expect(text(outcome.result).length).toBeGreaterThan(30_000)

    expect((yield* Effect.promise(() => Fs.stat(spillOf(outcome.result)))).size).toBe(
      400_000 + 'done\n'.length,
    )
  }),
)

it.live('bash names no file when the output fit', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const outcome = yield* call(root, (tools) => tools.handle('bash', { command: 'echo small' }))

    expect(outcome.result).toBe('exit 0\nsmall\n')
  }),
)

it.live('bash reports a shell it could not start at all', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() =>
      onDisk(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          yield* fs.remove(root, { recursive: true, force: true }).pipe(Effect.orDie)
        }),
      ),
    )

    const outcome = yield* call(root, (tools) => tools.handle('bash', { command: 'echo hello' }))

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(CommandRefused)
    expect(outcome.result).toMatchObject({
      reason: expect.stringContaining('bash could not run `echo hello`'),
    })
  }),
)
