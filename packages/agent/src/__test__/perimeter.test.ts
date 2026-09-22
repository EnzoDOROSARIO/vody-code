import { afterEach, expect, test } from 'bun:test'
import { BunServices } from '@effect/platform-bun'
import { Effect, FileSystem, Layer, Option, Path, PlatformError } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process'

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

test('the Perimeter is the working tree root, found from a Workspace anywhere inside it', async () => {
  const root = await workspace()

  const found = await discovered(
    `${root}/inside`,
    Effect.map(Perimeter, (perimeter) => perimeter.root),
  )

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

// The Perimeter is asked of git, so a machine without git is a machine with no
// Perimeter anywhere: not a defect, and not a tree that happens to be empty.
test('where git cannot be run there is no Perimeter', async () => {
  const root = await workspace()

  const gitless = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.badArgument({
          module: 'ChildProcess',
          method: 'spawn',
          description: 'git: command not found',
        }),
      ),
    ),
  )

  const found = await Effect.runPromise(
    Effect.map(Perimeter, (perimeter) => perimeter.root).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
      Effect.provide(
        Perimeter.layer.pipe(
          Layer.provide(gitless),
          Layer.provideMerge(BunServices.layer),
          Layer.provide(Layer.succeed(Workspace, root)),
        ),
      ),
    ),
  )

  expect(found).toEqual(Option.none())
})
