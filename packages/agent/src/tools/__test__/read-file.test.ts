import { afterEach, expect, test } from 'bun:test'
import { Effect, Stream } from 'effect'

import { call, text, workspace } from './harness.ts'
import { removeWorkspaces } from '#__test__/testing.ts'
import { FileIsBinary, FileNotRead, FileSystemRefused } from '#tools/index.ts'

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
  expect(outcome.result).toMatchObject({
    reason: expect.stringContaining('the bytes include NUL, so it is not text'),
  })
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

// One line under the budget is the whole of the file; the budget is spent across the
// lines kept, counting the newline that ends each one, and what does not fit is cut
// at the line that ran out rather than mid-way through it.
test('read_file spends its character budget across the lines, newlines included', async () => {
  const root = await workspace()

  const line = 'x'.repeat(99)

  await Bun.write(`${root}/wide.txt`, `${line}\n`.repeat(1010))

  const outcome = await call(root, (tools) => tools.handle('read_file', { path: 'wide.txt' }))

  const shown = text(outcome.result)

  expect(shown).toStartWith(`     1→${line}`)
  expect(shown).toEndWith(
    `\n  1000→${line}\n... (truncated at 100000 characters; 10 more lines; continue with offset 1001)`,
  )
})

// Both cuts fire at once: the line limit picks 1500 lines and the budget pays for 1000
// of them. What the model is told to continue from has to be the first line it was not
// shown, not the first line the limit left out — the 500 in between are on the near side
// of the limit and were still never sent.
test('read_file continues from the first line it did not show, not the first the limit dropped', async () => {
  const root = await workspace()

  const line = 'x'.repeat(99)

  await Bun.write(`${root}/wide.txt`, `${line}\n`.repeat(2100))

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'wide.txt', limit: 1500 }),
  )

  const shown = text(outcome.result)

  expect(shown).toContain(`\n  1000→${line}`)
  expect(shown).not.toContain('1001→')
  expect(shown).toEndWith(
    '... (truncated at 100000 characters; 1100 more lines; continue with offset 1001)',
  )
})

test('read_file says an offset one past the last line is past the end', async () => {
  const root = await workspace()

  await Bun.write(`${root}/three.txt`, 'a\nb\nc\n')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'three.txt', offset: 4 }),
  )

  expect(outcome.result).toBe('(offset 4 is past the end of three.txt, which has 3 lines)')
})

test('write_file will not overwrite on the strength of a read the budget cut short', async () => {
  const root = await workspace()

  await Bun.write(`${root}/wide.txt`, `${'x'.repeat(99)}\n`.repeat(1010))

  const outcome = await call(root, (tools) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(yield* tools.handle('read_file', { path: 'wide.txt' }))

      return yield* tools.handle('write_file', { path: 'wide.txt', content: 'clobbered' })
    }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileNotRead)
})
