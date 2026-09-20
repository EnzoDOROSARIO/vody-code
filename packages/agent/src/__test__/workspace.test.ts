import { expect, test } from 'bun:test'
import { Effect } from 'effect'

import { Workspace } from '#workspace.ts'

test('the workspace is where the process was started, until something says otherwise', () => {
  expect(Effect.runSync(Workspace)).toBe(process.cwd())
})
