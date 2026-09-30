import { afterEach, expect, test } from 'bun:test'
import { BunServices } from '@effect/platform-bun'
import { Effect, FileSystem, Layer, Option, Path } from 'effect'

import { onDisk, outside, removeWorkspaces, temporary, workspace } from './testing.ts'
import { Perimeter } from '#perimeter.ts'
import { Workspace } from '#workspace.ts'

afterEach(removeWorkspaces)

// The Perimeter as the agent would discover it from `directory`, with the real file
// system underneath so that links resolve as they will for a write. A question the
// file system refuses fails the test, which is all a failure here can mean.
const discovered = <A, E>(
  directory: string,
  ask: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Perimeter>,
): Promise<A> =>
  Effect.runPromise(
    ask.pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
      Effect.provide(
        Perimeter.layer.pipe(
          Layer.provideMerge(BunServices.layer),
          Layer.provide(Layer.succeed(Workspace, directory)),
        ),
      ),
    ),
  )

// The working tree root the agent would discover from `directory`, which is all most
// of these tests ask.
const rootFrom = (directory: string): Promise<Option.Option<string>> =>
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

test('the Perimeter is the working tree root, found from a Workspace anywhere inside it', async () => {
  const root = await workspace()

  const found = await rootFrom(`${root}/inside`)

  expect(found).toEqual(Option.some(root))
})

test('a Workspace in no repository has no Perimeter, and nothing is inside it', async () => {
  const directory = await onDisk(temporary)

  const [found, answer] = await discovered(
    directory,
    Effect.flatMap(Perimeter, (perimeter) =>
      Effect.all([Effect.succeed(perimeter.root), perimeter.contains(`${directory}/new.txt`)]),
    ),
  )

  expect(found).toEqual(Option.none())
  // Only the answer: the temporary directory sits behind a link on macOS, so the path it
  // reports is the real one, and pinning that here would repeat what `landing` does.
  expect(answer).toMatchObject({ inside: false })
})

test('Containment answers of the real path, and a target need not exist to have one', async () => {
  const root = await workspace()

  const answer = await discovered(
    root,
    Effect.flatMap(Perimeter, (perimeter) => perimeter.contains(`${root}/inside/not/yet/new.txt`)),
  )

  expect(answer).toEqual({ inside: true, path: `${root}/inside/not/yet/new.txt` })
})

test('a directory beside the working tree that shares its name as a prefix is outside', async () => {
  const root = await workspace()

  const answer = await discovered(
    root,
    Effect.flatMap(Perimeter, (perimeter) => perimeter.contains(`${root}-beside/new.txt`)),
  )

  expect(answer).toEqual({ inside: false, path: `${root}-beside/new.txt` })
})

// `.git` is out; `.gitignore` is a file in the tree that happens to start the same way.
test('the repository’s metadata is outside and a file named like it is not', async () => {
  const root = await workspace()

  const answers = await discovered(
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
})

test('a link is followed to where the write would land, then measured there', async () => {
  const root = await workspace()

  const answer = await discovered(
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
    path: `${outside(root)}/below/new.txt`,
  })
})

// A linked worktree's `.git` is a file naming its metadata inside the main repository,
// and that metadata keeps its objects and refs in the common directory it names.
test('a `.git` file naming a linked worktree’s metadata marks a working tree root', async () => {
  const root = await workspace()

  await Bun.write(`${root}/.git/worktrees/linked/HEAD`, 'ref: refs/heads/linked\n')
  await Bun.write(`${root}/.git/worktrees/linked/commondir`, '../..\n')
  await Bun.write(`${root}/inside/linked/.git`, `gitdir: ${root}/.git/worktrees/linked\n`)
  await Bun.write(`${root}/inside/linked/deep/keep.txt`, 'kept')

  expect(await rootFrom(`${root}/inside/linked/deep`)).toEqual(Option.some(`${root}/inside/linked`))
})

// A submodule's `.git` names its metadata relative to the file, not to the Workspace.
test('a `.git` file’s relative `gitdir:` is read from the file’s own directory', async () => {
  const root = await workspace()

  await repositoryAt(`${root}/.git/modules/sub`)
  await Bun.write(`${root}/inside/sub/.git`, 'gitdir: ../../.git/modules/sub\n')
  await Bun.write(`${root}/inside/sub/deep/keep.txt`, 'kept')

  expect(await rootFrom(`${root}/inside/sub/deep`)).toEqual(Option.some(`${root}/inside/sub`))
})

// git stops at such a file with "not a git repository", rather than climbing on to the
// tree above, so the Perimeter is none there too: the tree above is not where it is.
test('a `.git` file that names no repository ends the search with no Perimeter', async () => {
  const root = await workspace()

  await Bun.write(`${root}/inside/stale/.git`, 'gitdir: /nowhere\n')
  await Bun.write(`${root}/inside/garbled/.git`, 'not a gitfile\n')

  const found = await Promise.all([`${root}/inside/stale`, `${root}/inside/garbled`].map(rootFrom))

  expect(found).toEqual([Option.none(), Option.none()])
})

test('a repository nested inside another is its own Perimeter, the nearest one', async () => {
  const root = await workspace()

  await repositoryAt(`${root}/inside/nested/.git`)

  expect(await rootFrom(`${root}/inside/nested`)).toEqual(Option.some(`${root}/inside/nested`))
})

// git climbs past a `.git` directory that is not a repository, so the tree above it is
// the one the Workspace is in. It takes all three of `HEAD`, `objects` and `refs` to be
// one, so a directory missing any single part of them is passed over.
test('a `.git` directory that is not a repository is passed over for the tree above', async () => {
  const root = await workspace()
  const parts = ['HEAD', 'objects', 'refs']

  const found = await Promise.all(
    parts.map(async (missing) => {
      const hollow = `${root}/inside/without-${missing}`

      await repositoryAt(`${hollow}/.git`)

      await onDisk(
        Effect.flatMap(FileSystem.FileSystem, (fs) =>
          fs.remove(`${hollow}/.git/${missing}`, { recursive: true }),
        ).pipe(Effect.orDie),
      )

      return rootFrom(hollow)
    }),
  )

  expect(found).toEqual(parts.map(() => Option.some(root)))
})

// git says "this operation must be run in a work tree" there, and the Perimeter agrees:
// what is under `.git` is metadata, so a Workspace in it is in no working tree at all.
test('a Workspace in the repository’s own `.git`, or that is it, has no Perimeter', async () => {
  const root = await workspace()

  const found = await Promise.all([`${root}/.git`, `${root}/.git/refs`].map(rootFrom))

  expect(found).toEqual([Option.none(), Option.none()])
})

// A Workspace reached through a link is resolved before the walk, so the root is the
// tree's real path, the one every target is resolved to before it is measured.
test('a Workspace reached through a link has the Perimeter of where it really is', async () => {
  const root = await workspace()
  const alias = `${root.slice(0, root.lastIndexOf('/'))}/alias`

  await onDisk(
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.symlink(root, alias)).pipe(Effect.orDie),
  )

  const [found, answer] = await discovered(
    `${alias}/inside`,
    Effect.flatMap(Perimeter, (perimeter) =>
      Effect.all([Effect.succeed(perimeter.root), perimeter.contains(`${alias}/inside/new.txt`)]),
    ),
  )

  expect(found).toEqual(Option.some(root))
  expect(answer).toEqual({ inside: true, path: `${root}/inside/new.txt` })
  expect(await rootFrom(`${alias}/.git`)).toEqual(Option.none())
})

test('a Workspace that does not exist has no Perimeter', async () => {
  const root = await workspace()

  expect(await rootFrom(`${root}/inside/missing`)).toEqual(Option.none())
})

// Climbing past a directory it cannot look into could reach a larger tree above, so the
// walk stops there with nothing: the smaller answer is the safe one.
test('a Workspace whose directory cannot be looked into has no Perimeter', async () => {
  const root = await workspace()

  const permitted = (mode: number): Promise<void> =>
    onDisk(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.chmod(`${root}/inside`, mode)).pipe(
        Effect.orDie,
      ),
    )

  await permitted(0o000)

  try {
    expect(await rootFrom(`${root}/inside`)).toEqual(Option.none())
  } finally {
    // Put back, or the directory could not be removed with the rest of the workspace.
    await permitted(0o755)
  }
})
