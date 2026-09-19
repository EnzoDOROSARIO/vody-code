import { afterEach, expect, test } from 'bun:test'
import { Effect, FileSystem } from 'effect'

import { call, onDisk, removeWorkspaces, text, workspace } from './harness.ts'

import type { Outcome } from './harness.ts'
import { CommandRefused, CommandTimedOut } from '#tools/index.ts'

afterEach(removeWorkspaces)

const spillOf = (result: Outcome): string => {
  const named = /full output at (?<at>\S+?)\)/u.exec(text(result))?.groups?.['at']

  if (named === undefined) {
    throw new Error(`no spill file named in: ${text(result).slice(0, 120)}`)
  }

  return named
}

test('bash runs in the workspace and reports a clean exit', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: 'cat inside/keep.txt' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('exit 0\nkept')
})

test('bash reports a command that failed', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: 'echo trouble; exit 3' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('exit 3\ntrouble\n')
})

test('bash includes what a command wrote to stderr', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: 'echo complaint >&2' }),
  )

  expect(outcome.result).toBe('exit 0\ncomplaint\n')
})

test('bash marks a command that printed nothing', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('bash', { command: 'true' }))

  expect(outcome.result).toBe('exit 0\n(no output)')
})

test('bash closes stdin, so a command that reads it ends instead of hanging', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('bash', { command: 'cat' }))

  expect(outcome.result).toBe('exit 0\n(no output)')
})

test('bash kills a command that outstays its timeout, keeping what it printed', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: 'echo starting; sleep 30', timeout_seconds: 1 }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(CommandTimedOut)
  expect(outcome.result).toMatchObject({ output: 'starting\n', seconds: 1 })
})

test('bash keeps the end of output that would otherwise flood the context', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: `seq 1 20000; echo done` }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(text(outcome.result)).toEndWith('done\n')
  expect(text(outcome.result)).toContain('earlier characters omitted')
  expect(text(outcome.result).length).toBeLessThan(31_200)
})

test('bash writes the whole of a truncated output to a file it names', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: `seq 1 20000; echo done` }),
  )

  const whole = await Bun.file(spillOf(outcome.result)).text()

  expect(whole).toStartWith('1\n2\n3\n')
  expect(whole).toEndWith('20000\ndone\n')
})

test('bash keeps a whole tail even when one chunk is larger than the tail', async () => {
  const root = await workspace()

  // A single line far longer than the budget arrives in chunks bigger than the tail
  // itself, so trimming a whole chunk at a time would leave almost nothing behind.
  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: `head -c 400000 /dev/zero | tr '\\0' 'x'; echo done` }),
  )

  expect(text(outcome.result)).toEndWith('done\n')
  expect(text(outcome.result).length).toBeGreaterThan(30_000)

  expect(Bun.file(spillOf(outcome.result)).size).toBe(400_000 + 'done\n'.length)
})

test('bash names no file when the output fit', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('bash', { command: 'echo small' }))

  expect(outcome.result).toBe('exit 0\nsmall\n')
})

test('bash reports a shell it could not start at all', async () => {
  const root = await workspace()

  await onDisk(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      yield* fs.remove(root, { recursive: true, force: true }).pipe(Effect.orDie)
    }),
  )

  const outcome = await call(root, (tools) => tools.handle('bash', { command: 'echo hello' }))

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(CommandRefused)
})
