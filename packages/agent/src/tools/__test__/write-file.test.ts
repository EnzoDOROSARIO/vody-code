import { afterEach, expect, test } from 'bun:test'
import { Effect, Stream } from 'effect'

import { call, touch } from './harness.ts'
import { outside, removeWorkspaces, workspace } from '#__test__/testing.ts'
import { FileNotRead, FileSystemRefused, OutsidePerimeter } from '#tools/index.ts'

afterEach(removeWorkspaces)

test('write_file creates the parent directories it needs', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'a/b/new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('Created a/b/new.txt (5 bytes)')
  expect(await Bun.file(`${root}/a/b/new.txt`).text()).toBe('hello')
})

test('write_file reports the byte length, not the character count', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'emoji.txt', content: 'é🙂' }),
  )

  expect(outcome.result).toBe('Created emoji.txt (6 bytes)')
})

test('write_file will not overwrite a file that was never read', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'inside/keep.txt', content: 'clobbered' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileNotRead)
  // The refusal is the model's only instruction on what to do instead, and the two
  // ways a write is refused ask for different things.
  expect(outcome.result).toMatchObject({
    reason: expect.stringContaining('unseen — read_file all of it first'),
  })
  expect(await Bun.file(`${root}/inside/keep.txt`).text()).toBe('kept')
})

test('write_file overwrites a file that was read first, and says it did', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(yield* tools.handle('read_file', { path: 'inside/keep.txt' }))

      return yield* tools.handle('write_file', { path: 'inside/keep.txt', content: 'replaced' })
    }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('Overwrote inside/keep.txt (8 bytes)')
  expect(await Bun.file(`${root}/inside/keep.txt`).text()).toBe('replaced')
})

test('write_file will not overwrite on the strength of a read that showed nothing', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(
        yield* tools.handle('read_file', { path: 'inside/keep.txt', offset: 999 }),
      )

      return yield* tools.handle('write_file', { path: 'inside/keep.txt', content: 'clobbered' })
    }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileNotRead)
  expect(await Bun.file(`${root}/inside/keep.txt`).text()).toBe('kept')
})

test('write_file will not overwrite on the strength of a read that showed only part', async () => {
  const root = await workspace()

  await Bun.write(`${root}/long.txt`, 'a\nb\nc\nd')

  const outcome = await call(root, (tools) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(yield* tools.handle('read_file', { path: 'long.txt', limit: 2 }))

      return yield* tools.handle('write_file', { path: 'long.txt', content: 'clobbered' })
    }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileNotRead)
  expect(await Bun.file(`${root}/long.txt`).text()).toBe('a\nb\nc\nd')
})

// A read that starts partway down a file reaches its last line and is cut short by
// nothing, so everything but the offset says it was whole. The lines before the offset
// are still unseen, and overwriting on the strength of that read would drop them.
test('write_file will not overwrite on the strength of a read that started partway down', async () => {
  const root = await workspace()

  await Bun.write(`${root}/three.txt`, 'a\nb\nc\n')

  const outcome = await call(root, (tools) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(yield* tools.handle('read_file', { path: 'three.txt', offset: 2 }))

      return yield* tools.handle('write_file', { path: 'three.txt', content: 'clobbered' })
    }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileNotRead)
  expect(outcome.result).toMatchObject({
    reason: expect.stringContaining('unseen — read_file all of it first'),
  })
  expect(await Bun.file(`${root}/three.txt`).text()).toBe('a\nb\nc\n')
})

test('write_file will not overwrite a file that changed after it was read', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(yield* tools.handle('read_file', { path: 'inside/keep.txt' }))

      yield* Effect.promise(() => Bun.write(`${root}/inside/keep.txt`, 'changed elsewhere'))

      yield* Effect.promise(() => touch(`${root}/inside/keep.txt`, '2999-01-01T00:00:00Z'))

      return yield* tools.handle('write_file', { path: 'inside/keep.txt', content: 'clobbered' })
    }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileNotRead)
  expect(outcome.result).toMatchObject({
    reason: expect.stringContaining('it changed on disk after you read it'),
  })
  expect(await Bun.file(`${root}/inside/keep.txt`).text()).toBe('changed elsewhere')
})

test('write_file leaves no temporary file behind', async () => {
  const root = await workspace()

  await call(root, (tools) => tools.handle('write_file', { path: 'new.txt', content: 'hello' }))

  const left = await Array.fromAsync(new Bun.Glob('*').scan({ cwd: root, dot: true }))

  expect(left.filter((entry) => entry.endsWith('.tmp'))).toEqual([])
})

test('write_file reports a parent that cannot be made a directory', async () => {
  const root = await workspace()

  await Bun.write(`${root}/blocker`, 'not a directory')

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'blocker/new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileSystemRefused)
})

// The path is resolved against the Workspace, and that is what puts it outside the
// Perimeter: the fixture past the root is the outside-the-Perimeter case, unchanged.
// The landing path is pinned exactly, since resolving against the process's own
// directory instead would also end in `outside/new.txt`.
test('write_file resolves a relative path against the workspace, and so lands outside', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: '../outside/new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(OutsidePerimeter)
  expect(outcome.result).toMatchObject({ path: `${outside(root)}/new.txt` })
  expect(await Bun.file(`${outside(root)}/new.txt`).exists()).toBe(false)
})
