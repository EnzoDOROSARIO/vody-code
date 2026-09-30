import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from 'effect'

import type { PlatformError } from 'effect'

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
  static readonly layer: Layer.Layer<Perimeter, never, FileSystem.FileSystem | Path.Path> =
    Layer.effect(
      Perimeter,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const workspace = yield* Workspace

        // The repository's own metadata is not part of the working tree: a hook planted
        // there runs later, past every Gate. That goes for the entry itself as much as
        // for what is under it, since in a linked worktree `.git` is a file.
        const metadata = (tree: string, real: string): boolean => {
          const entry = path.join(tree, '.git')

          return real === entry || under(entry, real, path.sep)
        }

        // Whether git would take `suspect` for a repository's metadata, after its own
        // is_git_directory: a `HEAD` there, and `objects` and `refs` beside it, or in the
        // common directory named by the `commondir` file a linked worktree's metadata has.
        const repository = (suspect: string): Effect.Effect<boolean, PlatformError.PlatformError> =>
          Effect.gen(function* () {
            const shared = path.join(suspect, 'commondir')

            const common = (yield* fs.exists(shared))
              ? path.resolve(suspect, (yield* fs.readFileString(shared)).trim())
              : suspect

            const present = yield* Effect.forEach(
              [path.join(suspect, 'HEAD'), path.join(common, 'objects'), path.join(common, 'refs')],
              (required) => fs.exists(required),
            )

            return present.every((found) => found)
          })

        // Whether a `.git` file names a repository, as a linked worktree's or a
        // submodule's does: a `gitdir:` line, resolved against the file's own directory.
        const linked = (
          directory: string,
          file: string,
        ): Effect.Effect<boolean, PlatformError.PlatformError> =>
          fs.readFileString(file).pipe(
            Effect.flatMap((content) => {
              const line = content.trimEnd()
              const prefix = 'gitdir: '

              return line.startsWith(prefix)
                ? repository(path.resolve(directory, line.slice(prefix.length)))
                : Effect.succeed(false)
            }),
          )

        // What the `.git` entry in `directory` says of it, by git's reading: a working tree
        // starts here when the entry is a repository or a file naming one; a file naming
        // nothing usable ends the search, since git stops there with a fatal error; and
        // no entry, or a directory that is not a repository, sends the search on up.
        const mark = (
          directory: string,
        ): Effect.Effect<'tree' | 'stop' | 'climb', PlatformError.PlatformError> =>
          Effect.gen(function* () {
            const entry = path.join(directory, '.git')

            if (!(yield* fs.exists(entry))) {
              return 'climb'
            }

            if ((yield* fs.stat(entry)).type === 'Directory') {
              return (yield* repository(entry)) ? 'tree' : 'climb'
            }

            // Stryker disable next-line StringLiteral: 'stop' is the one mark `enclosing` does not
            // test for, since anything but 'tree' or 'climb' already ends the walk with nothing.
            return (yield* linked(directory, entry)) ? 'tree' : 'stop'
          })

        // Where the working tree around `directory` starts, found the way git finds it
        // but without asking git, so that building the Gate launches no process and git
        // being missing or slow cannot change the answer. It is an approximation: each
        // `.git` entry is checked for the parts git looks for, by their existence alone
        // and not their contents, and what git reads from the environment and its
        // configuration is left out — GIT_DIR, GIT_WORK_TREE, core.worktree,
        // GIT_CEILING_DIRECTORIES, safe.directory. Those belong to a shell or a machine
        // rather than to the tree, so the answer is the one the files on disk give, and it
        // can differ from what a `git` run under such settings reports. A directory that
        // cannot be looked into ends the walk with nothing, rather than letting it climb
        // to a larger tree above.
        const enclosing = (
          directory: string,
        ): Effect.Effect<Option.Option<string>, PlatformError.PlatformError> => {
          const parent = path.dirname(directory)

          return mark(directory).pipe(
            Effect.flatMap((found) => {
              if (found === 'tree') {
                return Effect.succeedSome(directory)
              }

              return found === 'climb' && parent !== directory
                ? enclosing(parent)
                : Effect.succeedNone
            }),
          )
        }

        // The walk starts from the real path because that is the form a target is
        // resolved to before the two are compared. A Workspace inside a repository's
        // `.git` is in no working tree, which is git's answer there too, so it has no
        // Perimeter rather than the tree whose metadata it is in.
        const root = yield* fs.realPath(workspace).pipe(
          Effect.flatMap((real) =>
            enclosing(real).pipe(Effect.map(Option.filter((tree) => !metadata(tree, real)))),
          ),
          Effect.catch(() => Effect.succeedNone),
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

        const inside = (real: string): boolean =>
          Option.match(root, {
            onNone: () => false,
            onSome: (tree) => under(tree, real, path.sep) && !metadata(tree, real),
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
