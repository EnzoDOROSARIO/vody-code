import { afterEach, expect, test } from 'bun:test'

import { call, text, touch, workspace } from './harness.ts'
import { removeWorkspaces } from '#__test__/testing.ts'

afterEach(removeWorkspaces)

const shell = async (root: string, command: string): Promise<void> => {
  await Bun.$`sh -c ${command}`.cwd(root).quiet()
}

test('glob finds files recursively, most recently modified first', async () => {
  const root = await workspace()

  await Bun.write(`${root}/older.ts`, '')
  await Bun.write(`${root}/inside/newer.ts`, '')

  await touch(`${root}/older.ts`, '2020-01-01T00:00:00Z')
  await touch(`${root}/inside/newer.ts`, '2024-01-01T00:00:00Z')

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '**/*.ts' }))

  expect(outcome.result).toBe('inside/newer.ts\nolder.ts')
})

test('glob returns files, not the directories on the way to them', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '*' }))

  expect(outcome.result).toBe('(no matches)')
})

test('glob skips what git ignores', async () => {
  const root = await workspace()

  await shell(root, 'git init -q')

  await Bun.write(`${root}/.gitignore`, 'build/\n')
  await Bun.write(`${root}/build/generated.ts`, '')
  await Bun.write(`${root}/kept.ts`, '')

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '**/*.ts' }))

  expect(outcome.result).toBe('kept.ts')
})

test('glob skips node_modules even where git has no say', async () => {
  const root = await workspace()

  await Bun.write(`${root}/node_modules/dependency/index.ts`, '')
  await Bun.write(`${root}/mine.ts`, '')

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '**/*.ts' }))

  expect(outcome.result).toBe('mine.ts')
})

test('glob still looks inside node_modules when the pattern names it', async () => {
  const root = await workspace()

  await Bun.write(`${root}/node_modules/dependency/index.ts`, '')

  const outcome = await call(root, (tools) =>
    tools.handle('glob', { pattern: 'node_modules/**/*.ts' }),
  )

  expect(outcome.result).toBe('node_modules/dependency/index.ts')
})

test('glob cuts a long list short and says it did', async () => {
  const root = await workspace()

  await Promise.all(
    Array.from({ length: 201 }, (_, index) =>
      Bun.write(`${root}/many/${String(index).padStart(3, '0')}.log`, ''),
    ),
  )

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: 'many/*.log' }))

  const lines = text(outcome.result).split('\n')

  expect(lines).toHaveLength(201)
  expect(lines[200]).toBe('... (1 more matches omitted, oldest first; narrow the pattern)')
})

test('glob says so when nothing matches', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '**/*.nothing' }))

  expect(outcome.result).toBe('(no matches)')
})

test('glob matches relative to the workspace, and may reach past it', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '../outside/*.txt' }))

  expect(outcome.result).toBe('../outside/secret.txt')
})
