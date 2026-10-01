import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { Workspace } from '#workspace.ts'

it('the workspace is where the process was started, until something says otherwise', () => {
  expect(Effect.runSync(Workspace)).toBe(process.cwd())
})
