import { afterEach, expect, test } from 'bun:test'

import { call, removeWorkspaces, text, workspace } from './harness.ts'
import { FileIsBinary, FileSystemRefused } from '../index.ts'

afterEach(removeWorkspaces)

test('read_file numbers the lines it returns', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'inside/keep.txt' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('     1→kept')
})

test('read_file counts a trailing newline as ending a line, not starting one', async () => {
  const root = await workspace()

  await Bun.write(`${root}/three.txt`, 'a\nb\nc\n')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'three.txt', limit: 3 }),
  )

  expect(outcome.result).toBe('     1→a\n     2→b\n     3→c')
})

test('read_file rejects a limit of zero rather than returning nothing', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'inside/keep.txt', limit: 0 }),
  )

  expect(outcome.isFailure).toBe(true)
})

test('read_file stops at the line limit and says where to continue', async () => {
  const root = await workspace()

  await Bun.write(`${root}/long.txt`, 'a\nb\nc\nd')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'long.txt', limit: 2 }),
  )

  expect(outcome.result).toBe('     1→a\n     2→b\n... (2 more lines; continue with offset 3)')
})

test('read_file starts at the offset it is given, numbering from there', async () => {
  const root = await workspace()

  await Bun.write(`${root}/long.txt`, 'a\nb\nc\nd')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'long.txt', offset: 3 }),
  )

  expect(outcome.result).toBe('     3→c\n     4→d')
})

test('read_file pages through a file with offset and limit together', async () => {
  const root = await workspace()

  await Bun.write(`${root}/long.txt`, 'a\nb\nc\nd\ne')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'long.txt', offset: 2, limit: 2 }),
  )

  expect(outcome.result).toBe('     2→b\n     3→c\n... (2 more lines; continue with offset 4)')
})

test('read_file says so when the offset is past the end', async () => {
  const root = await workspace()

  await Bun.write(`${root}/short.txt`, 'a\nb')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'short.txt', offset: 9 }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('(offset 9 is past the end of short.txt, which has 2 lines)')
})

test('read_file marks an empty file rather than returning nothing', async () => {
  const root = await workspace()

  await Bun.write(`${root}/empty.txt`, '')

  const outcome = await call(root, (tools) => tools.handle('read_file', { path: 'empty.txt' }))

  expect(outcome.result).toBe('(empty file)')
})

test('read_file refuses a binary file instead of decoding it to nonsense', async () => {
  const root = await workspace()

  await Bun.write(`${root}/image.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]))

  const outcome = await call(root, (tools) => tools.handle('read_file', { path: 'image.png' }))

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileIsBinary)
})

test('read_file clips a line too long to be bounded by a line limit', async () => {
  const root = await workspace()

  await Bun.write(`${root}/bundle.js`, 'x'.repeat(5_000_000))

  const outcome = await call(root, (tools) => tools.handle('read_file', { path: 'bundle.js' }))

  expect(outcome.isFailure).toBe(false)
  expect(text(outcome.result)).toEndWith('... (truncated at 100000 characters)')
  expect(text(outcome.result).length).toBeLessThan(101_000)
})

test('read_file reaches outside the workspace, the way bash can', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: '../outside/secret.txt' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('     1→secret')
})

test('read_file takes an absolute path as it is given', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: `${root}/../outside/secret.txt` }),
  )

  expect(outcome.result).toBe('     1→secret')
})

test('read_file reports a file that is not there', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('read_file', { path: 'missing.txt' }))

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileSystemRefused)
})
