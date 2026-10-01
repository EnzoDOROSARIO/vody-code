import { afterEach, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { call, text } from './harness.ts'
import { removeWorkspaces, workspace } from '#__test__/testing.ts'

afterEach(removeWorkspaces)

// Compared as they are: both sides are the real path, see `workspace`.
it.live('the workspace is a git repository whose working tree root is the workspace itself', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const outcome = yield* call(root, (tools) =>
      tools.handle('bash', { command: 'git rev-parse --show-toplevel' }),
    )

    expect(outcome.result).toBe(`exit 0\n${root}\n`)
  }),
)

it.live('the fixture outside the workspace lies outside its repository', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    const outcome = yield* call(root, (tools) =>
      tools.handle('bash', { command: 'git -C ../outside rev-parse --show-toplevel' }),
    )

    expect(text(outcome.result).startsWith('exit 128\n')).toBe(true)
    expect(text(outcome.result)).toContain('not a git repository')
  }),
)
