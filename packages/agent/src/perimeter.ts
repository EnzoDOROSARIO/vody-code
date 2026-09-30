import { Context, Effect, FileSystem, Layer, Option, Path } from 'effect'

import type { PlatformError } from 'effect'

import { Workspace } from './workspace.ts'

/**
 * Where a path really leads, whether that is inside the Perimeter, and whether it is in
 * the repository's own metadata, which lies under the root and is still not inside.
 */
export type Containment = {
  readonly inside: boolean
  readonly metadata: boolean
  readonly path: string
}

/**
 * Whether `child` sits under `parent`. Only strictly under: a target that is the
 * directory itself is not a file that could be written there.
 */
export const under = (parent: string, child: string, separator: string): boolean =>
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

        // Whether `real` is `directory` itself or lies anywhere under it.
        const within = (directory: string, real: string): boolean =>
          real === directory || under(directory, real, path.sep)

        // Where git keeps the parts a repository's metadata shares: the directory named
        // by the `commondir` file a linked worktree's metadata has, or else the metadata
        // itself.
        const common = (suspect: string): Effect.Effect<string, PlatformError.PlatformError> =>
          Effect.gen(function* () {
            const shared = path.join(suspect, 'commondir')

            return (yield* fs.exists(shared))
              ? path.resolve(suspect, (yield* fs.readFileString(shared)).trim())
              : suspect
          })

        // Whether git would take `suspect` for a repository's metadata, after its own
        // is_git_directory: a `HEAD` there, and `objects` and `refs` in its common
        // directory.
        const repository = (suspect: string): Effect.Effect<boolean, PlatformError.PlatformError> =>
          Effect.gen(function* () {
            const shared = yield* common(suspect)

            const present = yield* Effect.forEach(
              [path.join(suspect, 'HEAD'), path.join(shared, 'objects'), path.join(shared, 'refs')],
              (required) => fs.exists(required),
            )

            return present.every((found) => found)
          })

        // The metadata a `.git` file names, as a linked worktree's or a submodule's does:
        // a `gitdir:` line, resolved against the file's own directory. None for a file
        // with no such line.
        const named = (
          directory: string,
          file: string,
        ): Effect.Effect<Option.Option<string>, PlatformError.PlatformError> =>
          fs.readFileString(file).pipe(
            Effect.map((content) => {
              const line = content.trimEnd()
              const prefix = 'gitdir: '

              return line.startsWith(prefix)
                ? Option.some(path.resolve(directory, line.slice(prefix.length)))
                : Option.none()
            }),
          )

        // Whether a `.git` file names a repository.
        const linked = (
          directory: string,
          file: string,
        ): Effect.Effect<boolean, PlatformError.PlatformError> =>
          named(directory, file).pipe(
            Effect.flatMap(
              Option.match({ onNone: () => Effect.succeed(false), onSome: repository }),
            ),
          )

        // Every directory that is the tree's own metadata rather than part of the tree,
        // by its real path, since that is the form a landing path is in. A hook planted in
        // any of them runs later, past every Gate. It is the `.git` entry, and in a linked
        // worktree, whose `.git` is only a file, it is also the metadata that file names
        // and the common directory that metadata shares with the main checkout, where the
        // hooks are.
        const metadataOf = (
          tree: string,
        ): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError> =>
          Effect.gen(function* () {
            const entry = path.join(tree, '.git')

            const gitdir =
              (yield* fs.stat(entry)).type === 'Directory'
                ? Option.none<string>()
                : yield* named(tree, entry)

            const beyond = yield* Effect.forEach(Option.toArray(gitdir), (directory) =>
              Effect.map(common(directory), (shared) => [directory, shared]),
            )

            const real = yield* Effect.forEach([entry, ...beyond.flat()], (directory) =>
              fs.realPath(directory),
            )

            return [entry, ...real]
          })

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
        // metadata is in no working tree, which is git's answer there too, so it has no
        // Perimeter rather than the tree whose metadata it is in.
        const found = yield* fs.realPath(workspace).pipe(
          Effect.flatMap((real) =>
            enclosing(real).pipe(
              Effect.flatMap((tree) =>
                Effect.transposeOption(
                  Option.map(tree, (directory) =>
                    Effect.map(metadataOf(directory), (hidden) => ({ tree: directory, hidden })),
                  ),
                ),
              ),
              Effect.map(
                Option.filter(({ hidden }) => !hidden.some((directory) => within(directory, real))),
              ),
            ),
          ),
          Effect.catch(() => Effect.succeedNone),
        )

        const root = Option.map(found, ({ tree }) => tree)

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

        // Whether a path is inside, and whether it is the metadata, which lies under the
        // root and is still kept out.
        const where = (real: string): Omit<Containment, 'path'> =>
          Option.match(found, {
            onNone: () => ({ inside: false, metadata: false }),
            onSome: ({ hidden, tree }) => {
              const metadata = hidden.some((directory) => within(directory, real))

              return { inside: under(tree, real, path.sep) && !metadata, metadata }
            },
          })

        // Stryker disable next-line StringLiteral: the name only labels the span, which
        // nothing in the package reads.
        const contains = Effect.fn('Perimeter.contains')(function* (target: string) {
          const real = yield* landing(path.dirname(target), [path.basename(target)])

          return { ...where(real), path: real }
        })

        return Perimeter.of({ contains, root })
      }),
    )
}
