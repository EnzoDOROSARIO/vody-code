import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { Workspace } from '#workspace.ts'

// The Workspace is a port, not an ambient reference: whoever composes a program says
// where it works, and nothing below the composition root has a directory to fall back
// on. A test that asks for the port can only be written with one provided, which is
// the compiler's half of the same fact.
it.live('the workspace is the one the program was given, not where the process started', () =>
  Effect.gen(function* () {
    expect(yield* Workspace).toBe('/somewhere/else')
  }).pipe(Effect.provideService(Workspace, '/somewhere/else')),
)
