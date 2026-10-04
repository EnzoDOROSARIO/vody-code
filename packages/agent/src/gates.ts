import { Effect, Layer } from 'effect'

import type { FileSystem, Path } from 'effect'

import * as CommandGate from './command-gate.ts'
import type { Home } from './home.ts'
import { Perimeter } from './perimeter.ts'
import { Hooks } from './tools/hooks.ts'
import * as WriteGate from './write-gate.ts'

import type { Judge } from './judge.ts'
import type { Hook } from './tools/hooks.ts'
import type { Tools } from './tools/toolkit.ts'
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
  FileSystem.FileSystem | Home | Judge | Path.Path | Workspace
> = Layer.effect(
  Hooks,
  Effect.gen(function* () {
    const writes = yield* WriteGate.hooks

    const bash = yield* CommandGate.hook

    // The record names every tool, so a new one is a compile error until someone says
    // which side of the line it is on: a hook, or undefined for a tool no Gate stands in
    // front of. That is the decision `turn.ts` no longer has to be told about.
    return {
      bash,
      edit_file: writes.edit_file,
      glob: undefined,
      load_skill: undefined,
      read_file: undefined,
      write_file: writes.write_file,
      write_plan: undefined,
    } satisfies { readonly [Name in keyof Tools]: Hook<Name> | undefined }
  }),
).pipe(Layer.provide(Perimeter.layer))
