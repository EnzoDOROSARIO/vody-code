import { afterEach, expect, test } from 'bun:test'

import { call, workspace } from './harness.ts'
import { removeWorkspaces } from '#__test__/testing.ts'

afterEach(removeWorkspaces)

// Compared as they are: both sides are the real path, see `workspace`.
test('the workspace is a git repository whose working tree root is the workspace itself', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: 'git rev-parse --show-toplevel' }),
  )

  expect(outcome.result).toBe(`exit 0\n${root}\n`)
})

test('the fixture outside the workspace lies outside its repository', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: 'git -C ../outside rev-parse --show-toplevel' }),
  )

  expect(outcome.result).toStartWith('exit 128\n')
  expect(outcome.result).toContain('not a git repository')
})
