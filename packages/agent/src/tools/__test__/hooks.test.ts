import { afterEach, expect, test } from 'bun:test'
import { Effect, Ref, Stream } from 'effect'

import { call, workspace } from './harness.ts'
import { removeWorkspaces } from '#__test__/testing.ts'
import { FileSystemRefused } from '#tools/index.ts'
import type { Call } from '#tools/index.ts'

afterEach(removeWorkspaces)

test('a hook at the seam sees the call with its arguments in the tool’s own types', async () => {
  const root = await workspace()

  const seen = await Effect.runPromise(Ref.make<Array<Call<'write_file'>>>([]))

  const outcome = await call(
    root,
    (tools) => tools.handle('write_file', { path: 'new.txt', content: 'hello' }),
    { write_file: (made) => Ref.update(seen, (calls) => [...calls, made]) },
  )

  expect(await Effect.runPromise(Ref.get(seen))).toEqual([
    { name: 'write_file', params: { path: 'new.txt', content: 'hello' } },
  ])
  expect(outcome.isFailure).toBe(false)
  expect(await Bun.file(`${root}/new.txt`).text()).toBe('hello')
})

test('a hook that fails stops the call, and its failure is the tool’s answer', async () => {
  const root = await workspace()

  const outcome = await call(
    root,
    (tools) => tools.handle('write_file', { path: 'new.txt', content: 'hello' }),
    { write_file: () => new FileSystemRefused({ reason: 'stopped at the seam' }) },
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileSystemRefused)
  expect(outcome.result).toMatchObject({ reason: 'stopped at the seam' })
  expect(await Bun.file(`${root}/new.txt`).exists()).toBe(false)
})

// The same call answered twice, once with nothing at the seam and once through a hook
// that succeeds, so what is compared is the seam's effect on the answer and not the
// answer's wording, which is write_file's own business.
test('a hook that does nothing changes nothing', async () => {
  const unhooked = await workspace()
  const hooked = await workspace()

  const without = await call(unhooked, (tools) =>
    tools.handle('write_file', { path: 'new.txt', content: 'hello' }),
  )

  const through = await call(
    hooked,
    (tools) => tools.handle('write_file', { path: 'new.txt', content: 'hello' }),
    { write_file: () => Effect.void },
  )

  expect(through).toEqual(without)
  expect(await Bun.file(`${hooked}/new.txt`).text()).toBe('hello')
})

test('every tool passes through the seam on its way in', async () => {
  const root = await workspace()

  const seen = await Effect.runPromise(Ref.make<Array<Call>>([]))

  const record = (made: Call): Effect.Effect<void> => Ref.update(seen, (calls) => [...calls, made])

  await call(
    root,
    (tools) =>
      Effect.gen(function* () {
        yield* Stream.runDrain(yield* tools.handle('bash', { command: 'true' }))

        yield* Stream.runDrain(
          yield* tools.handle('edit_file', {
            path: 'inside/keep.txt',
            old_text: 'kept',
            new_text: 'kept',
          }),
        )

        yield* Stream.runDrain(yield* tools.handle('glob', { pattern: '**/*.txt' }))

        yield* Stream.runDrain(
          yield* tools.handle('read_file', { path: 'inside/keep.txt', offset: 1 }),
        )

        return yield* tools.handle('write_file', { path: 'new.txt', content: 'hello' })
      }),
    { bash: record, edit_file: record, glob: record, read_file: record, write_file: record },
  )

  expect(await Effect.runPromise(Ref.get(seen))).toEqual([
    { name: 'bash', params: { command: 'true' } },
    { name: 'edit_file', params: { path: 'inside/keep.txt', old_text: 'kept', new_text: 'kept' } },
    { name: 'glob', params: { pattern: '**/*.txt' } },
    { name: 'read_file', params: { path: 'inside/keep.txt', offset: 1 } },
    { name: 'write_file', params: { path: 'new.txt', content: 'hello' } },
  ])
})
