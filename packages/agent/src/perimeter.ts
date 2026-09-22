import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from 'effect'

import type { PlatformError } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { Workspace } from './workspace.ts'

/**
 * A write refused at the Gate because it would land outside the Perimeter, which is
 * where every write lands when the Workspace is in no repository at all. `path` is
 * where it would really have landed, links resolved; `reason` is what the model is
 * told, and what the transcript shows.
 */
export class OutsidePerimeter extends Schema.TaggedError<OutsidePerimeter>()('OutsidePerimeter', {
  path: Schema.String,
  reason: Schema.String,
}) {}

/** Where a path really leads, and whether that is inside the Perimeter. */
export type Containment = {
  readonly inside: boolean
  readonly path: string
}

// Whether `child` sits under `parent`. Only strictly under: a target that is the
// directory itself is not a file that could be written there.
const under = (parent: string, child: string, separator: string): boolean =>
  child.startsWith(parent + separator)

/**
 * The git working tree the agent may change freely, and Containment: the question of
 * whether a path lies inside it.
 *
 * Discovered from the Workspace when the layer is built, so a Workspace in no repository
 * gives a Perimeter that is none, and every path is outside it. The Workspace is where
 * relative paths resolve; the Perimeter is only what this measures against.
 */
// Stryker disable StringLiteral: the key only names the service in a context, and nothing
// else in the package claims a name it could collide with.
export class Perimeter extends Context.Service<
  Perimeter,
  {
    /** The real path of the working tree root, or none where there is no repository. */
    readonly root: Option.Option<string>
    /**
     * Where an absolute `target` would really land, and whether that is inside.
     *
     * The target usually does not exist yet, and a write lands through a sibling
     * renamed into the directory, so the directory is what is resolved: the nearest
     * ancestor that does exist, through every symbolic link, with the rest of the path
     * put back beneath it. A link inside the tree that points elsewhere therefore leads
     * outside, and one outside that points in leads inside.
     */
    readonly contains: (target: string) => Effect.Effect<Containment, PlatformError.PlatformError>
  }
>()('agent/Perimeter') {
  // Stryker restore StringLiteral
  static readonly layer: Layer.Layer<
    Perimeter,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > = Layer.effect(
    Perimeter,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const workspace = yield* Workspace

      // git names the tree by its real path, which is the form a target is resolved to
      // before the two are compared. Only stdout is read, and git writes nothing there
      // when it finds no working tree — so the empty answer and a git that could not be
      // run both come out as no Perimeter, which is the safe side to land on.
      const printed = yield* spawner
        .string(ChildProcess.make('git', ['rev-parse', '--show-toplevel'], { cwd: workspace }))
        .pipe(Effect.option)

      const root = printed.pipe(
        Option.map((answer) => answer.trimEnd()),
        Option.filter((tree) => tree !== ''),
      )

      // The nearest existing ancestor is found by asking downwards from the target's
      // own directory: a directory that cannot be resolved cannot be written into by
      // this process either, so its unresolved name is kept as it is and the walk
      // moves up. The file system root always resolves, which is what ends the walk.
      const landing = (
        directory: string,
        rest: ReadonlyArray<string>,
      ): Effect.Effect<string, PlatformError.PlatformError> => {
        const parent = path.dirname(directory)

        return fs.realPath(directory).pipe(
          Effect.map((real) => path.join(real, ...rest)),
          Effect.catch((error) =>
            // Stryker disable next-line ConditionalExpression: the branch only opens when
            // the file system root itself cannot be resolved, which no test can arrange.
            parent === directory
              ? Effect.fail(error)
              : landing(parent, [path.basename(directory), ...rest]),
          ),
        )
      }

      // The repository's own metadata is not part of the working tree: a hook planted
      // there runs later, past every Gate. That goes for the entry itself as much as
      // for what is under it, since in a linked worktree `.git` is a file.
      const inside = (real: string): boolean =>
        Option.match(root, {
          onNone: () => false,
          onSome: (tree) => {
            const metadata = path.join(tree, '.git')

            return (
              under(tree, real, path.sep) && real !== metadata && !under(metadata, real, path.sep)
            )
          },
        })

      // Stryker disable next-line StringLiteral: the name only labels the span, which
      // nothing in the package reads.
      const contains = Effect.fn('Perimeter.contains')(function* (target: string) {
        const real = yield* landing(path.dirname(target), [path.basename(target)])

        return { inside: inside(real), path: real }
      })

      return Perimeter.of({ contains, root })
    }),
  )
}
