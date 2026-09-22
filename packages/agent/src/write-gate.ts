import { Effect, Layer, Option, Path } from 'effect'

import type { FileSystem } from 'effect'
import type { ChildProcessSpawner } from 'effect/unstable/process'

import { OutsidePerimeter, Perimeter } from './perimeter.ts'
import { refused } from './tools/errors.ts'
import { Hooks } from './tools/hooks.ts'
import { Workspace } from './workspace.ts'

import type { FileSystemRefused } from './tools/errors.ts'
import type { Call } from './tools/toolkit.ts'

// The Gate in front of the two tools that write. It is blunt for now: a target outside
// the Perimeter is refused outright, and nothing is asked. Replacing that refusal with a
// Verdict is a change to `examine` alone; where it hangs on the seam stays as it is.
const hooks: Effect.Effect<Hooks, never, Perimeter | Path.Path> = Effect.gen(function* () {
  const path = yield* Path.Path

  const perimeter = yield* Perimeter

  const workspace = yield* Workspace

  // The Gate resolves the path exactly as the tool it stands in front of will, so what
  // is examined is where the write is about to go, not where the model wrote it.
  // Stryker disable next-line StringLiteral: the name only labels the span, which nothing
  // in the package reads.
  const examine = Effect.fn('WriteGate.examine')(
    (
      call: Call<'edit_file' | 'write_file'>,
    ): Effect.Effect<void, FileSystemRefused | OutsidePerimeter> =>
      perimeter.contains(path.resolve(workspace, call.params.path)).pipe(
        Effect.mapError(refused),
        Effect.flatMap(({ inside, path: landing }) =>
          inside
            ? Effect.void
            : new OutsidePerimeter({
                path: landing,
                // No Perimeter is git's empty answer and git failing to run in one, so
                // the refusal says what was found rather than what the Workspace is.
                reason: Option.match(perimeter.root, {
                  onNone: () =>
                    `${call.name} will not write ${call.params.path}: git found no working tree at ${workspace}, or could not be run there, so there is nothing here the agent may change — nothing can be written until there is`,
                  onSome: (root) =>
                    `${call.name} will not write ${call.params.path}: it would land at ${landing}, outside the working tree at ${root} — only files inside that tree can be changed`,
                }),
              }),
        ),
      ),
  )

  return { edit_file: examine, write_file: examine }
})

/** Occupies the seam with the write Gate, with the Perimeter it measures against. */
export const layer: Layer.Layer<
  never,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Layer.effect(Hooks, hooks).pipe(Layer.provide(Perimeter.layer))
