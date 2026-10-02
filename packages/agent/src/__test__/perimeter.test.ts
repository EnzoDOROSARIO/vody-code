import { afterEach, expect, it } from '@effect/vitest'
import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Layer, Option, Path } from 'effect'

import { onDisk, outside, removeWorkspaces, temporary, workspace, write } from './testing.ts'
import { Perimeter } from '#perimeter.ts'
import { Workspace } from '#workspace.ts'

afterEach(removeWorkspaces)

// The Perimeter as the agent would discover it from `directory`, with the real file
// system underneath so that links resolve as they will for a write. A question the
// file system refuses fails the test, which is all a failure here can mean.
const discovered = <A, E>(
  directory: string,
  ask: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Perimeter>,
): Effect.Effect<A> =>
  ask.pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
    Effect.provide(
      Perimeter.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(Layer.succeed(Workspace, directory)),
      ),
    ),
    Effect.orDie,
  )

// The working tree root the agent would discover from `directory`, which is all most
// of these tests ask.
const rootFrom = (directory: string): Effect.Effect<Option.Option<string>> =>
  discovered(
    directory,
    Effect.map(Perimeter, (perimeter) => perimeter.root),
  )

// The least git takes for a repository's metadata: a `HEAD`, with `objects` and `refs`.
const repositoryAt = (directory: string): Promise<void> =>
  onDisk(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      yield* fs.makeDirectory(`${directory}/objects`, { recursive: true })
      yield* fs.makeDirectory(`${directory}/refs`, { recursive: true })
      yield* fs.writeFileString(`${directory}/HEAD`, 'ref: refs/heads/main\n')
    }).pipe(Effect.orDie),
  )

it.live('the Perimeter is the working tree root, found from a Workspace anywhere inside it', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const found = yield* rootFrom(`${root}/inside`)

    expect(found).toEqual(Option.some(root))
  }),
)

it.live('a Workspace in no repository has no Perimeter, and nothing is inside it', () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => onDisk(temporary))

    const [found, answer] = yield* discovered(
      directory,
      Effect.flatMap(Perimeter, (perimeter) =>
        Effect.all([Effect.succeed(perimeter.root), perimeter.contains(`${directory}/new.txt`)]),
      ),
    )

    expect(found).toEqual(Option.none())
    // Only the answer: the temporary directory sits behind a link on macOS, so the path it
    // reports is the real one, and pinning that here would repeat what `landing` does.
    expect(answer).toMatchObject({ inside: false, metadata: false })
  }),
)

it.live('Containment answers of the real path, and a target need not exist to have one', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const answer = yield* discovered(
      root,
      Effect.flatMap(Perimeter, (perimeter) =>
        perimeter.contains(`${root}/inside/not/yet/new.txt`),
      ),
    )

    expect(answer).toEqual({
      inside: true,
      metadata: false,
      path: `${root}/inside/not/yet/new.txt`,
    })
  }),
)

it.live('a directory beside the working tree that shares its name as a prefix is outside', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const answer = yield* discovered(
      root,
      Effect.flatMap(Perimeter, (perimeter) => perimeter.contains(`${root}-beside/new.txt`)),
    )

    expect(answer).toEqual({ inside: false, metadata: false, path: `${root}-beside/new.txt` })
  }),
)

// `.git` is out; `.gitignore` is a file in the tree that happens to start the same way.
it.live('the repository’s metadata is outside and a file named like it is not', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const answers = yield* discovered(
      root,
      Effect.flatMap(Perimeter, (perimeter) =>
        Effect.all([
          perimeter.contains(`${root}/.git`),
          perimeter.contains(`${root}/.git/config`),
          perimeter.contains(`${root}/.gitignore`),
        ]),
      ),
    )

    expect(answers.map((answer) => answer.inside)).toEqual([false, false, true])
    // Outside for being the metadata, which is what the Gate tells the Judge.
    expect(answers.map((answer) => answer.metadata)).toEqual([true, true, false])
  }),
)

it.live('a link is followed to where the write would land, then measured there', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const answer = yield* discovered(
      root,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path

        const perimeter = yield* Perimeter

        yield* fs.symlink(outside(root), path.join(root, 'link')).pipe(Effect.orDie)

        return yield* perimeter.contains(path.join(root, 'link', 'below', 'new.txt'))
      }),
    )

    expect(answer).toEqual({
      inside: false,
      metadata: false,
      path: `${outside(root)}/below/new.txt`,
    })
  }),
)

// A linked worktree's `.git` is a file naming its metadata inside the main repository,
// and that metadata keeps its objects and refs in the common directory it names.
it.live('a `.git` file naming a linked worktree’s metadata marks a working tree root', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() =>
      write(`${root}/.git/worktrees/linked/HEAD`, 'ref: refs/heads/linked\n'),
    )
    yield* Effect.promise(() => write(`${root}/.git/worktrees/linked/commondir`, '../..\n'))
    yield* Effect.promise(() =>
      write(`${root}/inside/linked/.git`, `gitdir: ${root}/.git/worktrees/linked\n`),
    )
    yield* Effect.promise(() => write(`${root}/inside/linked/deep/keep.txt`, 'kept'))

    expect(yield* rootFrom(`${root}/inside/linked/deep`)).toEqual(
      Option.some(`${root}/inside/linked`),
    )
  }),
)

// A submodule's `.git` names its metadata relative to the file, not to the Workspace.
it.live('a `.git` file’s relative `gitdir:` is read from the file’s own directory', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => repositoryAt(`${root}/.git/modules/sub`))
    yield* Effect.promise(() =>
      write(`${root}/inside/sub/.git`, 'gitdir: ../../.git/modules/sub\n'),
    )
    yield* Effect.promise(() => write(`${root}/inside/sub/deep/keep.txt`, 'kept'))

    expect(yield* rootFrom(`${root}/inside/sub/deep`)).toEqual(Option.some(`${root}/inside/sub`))
  }),
)

// git stops at such a file with "not a git repository", rather than climbing on to the
// tree above, so the Perimeter is none there too: the tree above is not where it is.
it.live('a `.git` file that names no repository ends the search with no Perimeter', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => write(`${root}/inside/stale/.git`, 'gitdir: /nowhere\n'))
    yield* Effect.promise(() => write(`${root}/inside/garbled/.git`, 'not a gitfile\n'))

    const found = yield* Effect.forEach(
      [`${root}/inside/stale`, `${root}/inside/garbled`],
      rootFrom,
    )

    expect(found).toEqual([Option.none(), Option.none()])
  }),
)

it.live('a repository nested inside another is its own Perimeter, the nearest one', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => repositoryAt(`${root}/inside/nested/.git`))

    expect(yield* rootFrom(`${root}/inside/nested`)).toEqual(Option.some(`${root}/inside/nested`))
  }),
)

// git climbs past a `.git` directory that is not a repository, so the tree above it is
// the one the Workspace is in. It takes all three of `HEAD`, `objects` and `refs` to be
// one, so a directory missing any single part of them is passed over.
it.live('a `.git` directory that is not a repository is passed over for the tree above', () =>
  Effect.gen(function* () {
    const root = yield* workspace
    const parts = ['HEAD', 'objects', 'refs']

    const found = yield* Effect.forEach(parts, (missing) =>
      Effect.gen(function* () {
        const hollow = `${root}/inside/without-${missing}`

        yield* Effect.promise(() => repositoryAt(`${hollow}/.git`))

        yield* Effect.promise(() =>
          onDisk(
            Effect.flatMap(FileSystem.FileSystem, (fs) =>
              fs.remove(`${hollow}/.git/${missing}`, { recursive: true }),
            ).pipe(Effect.orDie),
          ),
        )

        return yield* rootFrom(hollow)
      }),
    )

    expect(found).toEqual(parts.map(() => Option.some(root)))
  }),
)

// git says "this operation must be run in a work tree" there, and the Perimeter agrees:
// what is under `.git` is metadata, so a Workspace in it is in no working tree at all.
it.live('a Workspace in the repository’s own `.git`, or that is it, has no Perimeter', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const found = yield* Effect.forEach([`${root}/.git`, `${root}/.git/refs`], rootFrom)

    expect(found).toEqual([Option.none(), Option.none()])
  }),
)

// `git init --separate-git-dir` can put the metadata anywhere, the tree itself included,
// and leave only a `.git` file naming it. That metadata is still the tree's, and a
// Workspace inside it is as much in no working tree as one inside a `.git` directory,
// though the `.git` entry itself is somewhere else.
it.live(
  'a Workspace in the metadata a `.git` file names, kept inside the tree, has no Perimeter',
  () =>
    Effect.gen(function* () {
      // By its real path, since the temporary directory sits behind a link on macOS.
      const tree = yield* Effect.promise(() =>
        onDisk(
          Effect.flatMap(temporary, (directory) =>
            Effect.flatMap(FileSystem.FileSystem, (fs) => fs.realPath(directory)),
          ).pipe(Effect.orDie),
        ),
      )

      yield* Effect.promise(() => repositoryAt(`${tree}/meta`))
      yield* Effect.promise(() => write(`${tree}/.git`, 'gitdir: meta\n'))

      expect(yield* rootFrom(tree)).toEqual(Option.some(tree))
      expect(yield* rootFrom(`${tree}/meta/refs`)).toEqual(Option.none())
    }),
)

// A Workspace reached through a link is resolved before the walk, so the root is the
// tree's real path, the one every target is resolved to before it is measured.
it.live('a Workspace reached through a link has the Perimeter of where it really is', () =>
  Effect.gen(function* () {
    const root = yield* workspace
    const alias = `${root.slice(0, root.lastIndexOf('/'))}/alias`

    yield* Effect.promise(() =>
      onDisk(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.symlink(root, alias)).pipe(Effect.orDie),
      ),
    )

    const [found, answer] = yield* discovered(
      `${alias}/inside`,
      Effect.flatMap(Perimeter, (perimeter) =>
        Effect.all([Effect.succeed(perimeter.root), perimeter.contains(`${alias}/inside/new.txt`)]),
      ),
    )

    expect(found).toEqual(Option.some(root))
    expect(answer).toEqual({ inside: true, metadata: false, path: `${root}/inside/new.txt` })
    expect(yield* rootFrom(`${alias}/.git`)).toEqual(Option.none())
  }),
)

it.live('a Workspace that does not exist has no Perimeter', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    expect(yield* rootFrom(`${root}/inside/missing`)).toEqual(Option.none())
  }),
)

// Climbing past a directory it cannot look into could reach a larger tree above, so the
// walk stops there with nothing: the smaller answer is the safe one.
it.live('a Workspace whose directory cannot be looked into has no Perimeter', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const permitted = (mode: number): Promise<void> =>
      onDisk(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.chmod(`${root}/inside`, mode)).pipe(
          Effect.orDie,
        ),
      )

    yield* Effect.promise(() => permitted(0o000))

    try {
      expect(yield* rootFrom(`${root}/inside`)).toEqual(Option.none())
    } finally {
      // Put back, or the directory could not be removed with the rest of the workspace.
      yield* Effect.promise(() => permitted(0o755))
    }
  }),
)
