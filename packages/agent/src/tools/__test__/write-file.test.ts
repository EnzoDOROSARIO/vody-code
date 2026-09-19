import { afterEach, expect, test } from 'bun:test'
import { Effect, Stream } from 'effect'

import { call, removeWorkspaces, touch, workspace } from './harness.ts'
import { FileNotRead, FileSystemRefused } from '../index.ts'

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

test('write_file resolves a relative path against the workspace', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: '../outside/new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(await Bun.file(`${root}/../outside/new.txt`).text()).toBe('hello')
})
