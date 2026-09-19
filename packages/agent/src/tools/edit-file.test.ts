import { afterEach, expect, test } from 'bun:test'
import { Effect, Stream } from 'effect'

import { call, removeWorkspaces, text, workspace } from './harness.ts'
import { TextNotFound, TextNotUnique } from './index.ts'

afterEach(removeWorkspaces)

const utf8 = (contents: string): Array<number> => [...new TextEncoder().encode(contents)]

const bytesOf = async (target: string): Promise<Array<number>> => [
  ...new Uint8Array(await Bun.file(target).arrayBuffer()),
]

test('edit_file replaces a unique occurrence and shows the edited lines', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one\ntwo\nthree')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'edit.txt', old_text: 'two', new_text: 'TWO' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe(
    'Edited edit.txt (1 replacement)\n     1→one\n     2→TWO\n     3→three',
  )
  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('one\nTWO\nthree')
})

test('edit_file inserts the replacement literally, dollar signs and all', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'before')

  await call(root, (tools) =>
    tools.handle('edit_file', { path: 'edit.txt', old_text: 'before', new_text: '$& $1 $$' }),
  )

  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('$& $1 $$')
})

test('edit_file refuses an ambiguous match rather than picking the first', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one two one')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'edit.txt', old_text: 'one', new_text: 'ONE' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(TextNotUnique)
  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('one two one')
})

test('edit_file changes every occurrence when asked to', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one two one')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', {
      path: 'edit.txt',
      old_text: 'one',
      new_text: 'ONE',
      replace_all: true,
    }),
  )

  expect(text(outcome.result)).toStartWith('Edited edit.txt (2 replacements)')
  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('ONE two ONE')
})

test('edit_file leaves the file untouched when the text is not there', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one two')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'edit.txt', old_text: 'three', new_text: 'four' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(TextNotFound)
  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('one two')
})

test('edit_file rejects an empty old_text instead of prepending', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one two')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'edit.txt', old_text: '', new_text: 'x' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(TextNotFound)
  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('one two')
})

test('edit_file matches old_text written with newlines against a file using CRLF', async () => {
  const root = await workspace()

  await Bun.write(`${root}/crlf.txt`, 'one\r\ntwo\r\nthree\r\n')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', {
      path: 'crlf.txt',
      old_text: 'one\ntwo\n',
      new_text: 'one\nTWO\n',
    }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(await Bun.file(`${root}/crlf.txt`).text()).toBe('one\r\nTWO\r\nthree\r\n')
})

test('edit_file shows the edited lines without the carriage returns around them', async () => {
  const root = await workspace()

  await Bun.write(`${root}/crlf.txt`, 'one\r\ntwo\r\nthree\r\n')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'crlf.txt', old_text: 'two', new_text: 'TWO' }),
  )

  expect(outcome.result).toBe(
    'Edited crlf.txt (1 replacement)\n     1→one\n     2→TWO\n     3→three',
  )
})

test('edit_file leaves a file of mixed line endings alone outside the part it changed', async () => {
  const root = await workspace()

  await Bun.write(`${root}/mixed.txt`, 'one\r\ntwo\nthree\r\n')

  await call(root, (tools) =>
    tools.handle('edit_file', { path: 'mixed.txt', old_text: 'three', new_text: 'THREE' }),
  )

  expect(await Bun.file(`${root}/mixed.txt`).text()).toBe('one\r\ntwo\nTHREE\r\n')
})

test('edit_file reaches every occurrence of mixed endings when replacing all', async () => {
  const root = await workspace()

  await Bun.write(`${root}/n.txt`, 'a\r\nX\r\nb\r\nc\nX\nd\n')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', {
      path: 'n.txt',
      old_text: 'X\n',
      new_text: 'Y\n',
      replace_all: true,
    }),
  )

  expect(text(outcome.result)).toStartWith('Edited n.txt (2 replacements)')
  expect(await Bun.file(`${root}/n.txt`).text()).toBe('a\r\nY\r\nb\r\nc\nY\nd\n')
})

test('edit_file counts occurrences of either framing before calling a match unique', async () => {
  const root = await workspace()

  await Bun.write(`${root}/n.txt`, 'a\r\nX\r\nb\r\nc\nX\nd\n')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'n.txt', old_text: 'X\n', new_text: 'Y\n' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(TextNotUnique)
  expect(outcome.result).toMatchObject({ occurrences: 2 })
  expect(await Bun.file(`${root}/n.txt`).text()).toBe('a\r\nX\r\nb\r\nc\nX\nd\n')
})

test('edit_file keeps the byte order mark a file opened with', async () => {
  const root = await workspace()

  await Bun.write(`${root}/bom.txt`, '\uFEFFone\ntwo\n')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'bom.txt', old_text: 'two', new_text: 'TWO' }),
  )

  expect(outcome.isFailure).toBe(false)
  // `Bun.file().text()` drops a leading mark, so read the bytes to see it survived.
  expect(await bytesOf(`${root}/bom.txt`)).toEqual([0xef, 0xbb, 0xbf, ...utf8('one\nTWO\n')])
})

test('edit_file does not match a byte order mark the model could not have seen', async () => {
  const root = await workspace()

  await Bun.write(`${root}/bom.txt`, '\uFEFFone\n')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'bom.txt', old_text: 'one', new_text: 'ONE' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(await bytesOf(`${root}/bom.txt`)).toEqual([0xef, 0xbb, 0xbf, ...utf8('ONE\n')])
})

test('edit_file lets write_file overwrite afterwards, having read the file itself', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one')

  const outcome = await call(root, (tools) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(
        yield* tools.handle('edit_file', { path: 'edit.txt', old_text: 'one', new_text: 'two' }),
      )

      return yield* tools.handle('write_file', { path: 'edit.txt', content: 'three' })
    }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('Overwrote edit.txt (5 bytes)')
})
