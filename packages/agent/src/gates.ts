import { Effect, Layer } from 'effect'

import type { FileSystem, Path } from 'effect'

import * as CommandGate from './command-gate.ts'
import { Perimeter } from './perimeter.ts'
import { Hooks } from './tools/hooks.ts'
import * as WriteGate from './write-gate.ts'

import type { Judge } from './judge.ts'
import type { Workspace } from './workspace.ts'

/**
 * Occupies the seam with both Gates: the write Gate in front of the two tools that
 * write, and the command Gate in front of `bash`. The seam holds one value, so it is
 * built here from both Gates' hooks, over the one Perimeter they both measure against,
 * and each Gate keeps its own questions and policy. The Judge is left to whoever mounts
 * it: the agent's own, or the tests' scripted one.
 */
export const layer: Layer.Layer<
  never,
  never,
  FileSystem.FileSystem | Judge | Path.Path | Workspace
> = Layer.effect(
  Hooks,
  Effect.gen(function* () {
    const writes = yield* WriteGate.hooks

    const bash = yield* CommandGate.hook

    return { ...writes, bash }
  }),
).pipe(Layer.provide(Perimeter.layer))
