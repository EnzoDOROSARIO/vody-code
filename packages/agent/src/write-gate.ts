import { Effect, Layer, Option, Path } from 'effect'

import type { FileSystem } from 'effect'

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
                // No Perimeter covers a Workspace with no repository above it, one inside
                // a repository's own `.git`, one under a `.git` file naming nothing, and
                // one whose directories cannot be looked into, so the refusal says what
                // was found rather than which it was.
                reason: Option.match(perimeter.root, {
                  onNone: () =>
                    `${call.name} will not write ${call.params.path}: no git working tree could be found from ${workspace}, so there is nothing here the agent may change — nothing can be written until there is`,
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
export const layer: Layer.Layer<never, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  Hooks,
  hooks,
).pipe(Layer.provide(Perimeter.layer))
