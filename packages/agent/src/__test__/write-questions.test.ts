import { afterEach, expect, it } from '@effect/vitest'
import { ConfigProvider, Effect, FileSystem, Layer, Option, Queue } from 'effect'
import type { Schema } from 'effect'
import { Decision } from 'effect/unstable/ai'
import type { Toolkit } from 'effect/unstable/ai'

import { allows, judging } from './judging.ts'
import {
  judged,
  onDisk,
  outside,
  removeWorkspaces,
  temporary,
  workspace,
  write,
} from './testing.ts'
import { Request } from '#request.ts'
import { definition } from '#write-questions.ts'
import { outcome } from '#tools/__test__/harness.ts'

import type { Handle } from '#tools/__test__/harness.ts'

import type { Tools } from '#tools/index.ts'

afterEach(removeWorkspaces)

// What the Judge is told about a write is the whole of what it knows, with no other
// documentation it could go and read, so the wording is part of how the Gate behaves.
// It is pinned here in full: a change to what the Judge is told is made on purpose.
it('the Judge is asked about a write in these words', () => {
  const act = [
    'A coding agent is about to write a file outside the git working tree it may change freely.',
    '`tool` is how it writes: write_file creates the file or replaces all of it, edit_file',
    'replaces text inside a file that already exists. `path` is where the write lands, with',
    'symbolic links resolved. `exists` says whether a file is already there. `underHome` says',
    'whether the path is inside the user’s home directory. `insideAnotherRepository` says',
    'whether it is inside a git repository other than the working tree.',
    '`insideRepositoryMetadata` says whether it is inside the working tree’s own git',
    'metadata, where a hook would later run code that nothing examines. `perimeter` is the',
    'root of the working tree, or null when no working tree could be found from `workspace`,',
    'and then every write is outside. `workspace` is the directory the agent is working in.',
    '`request` is what the person typed to start the work in hand, exactly as typed, or null',
    'when there is none: it is the only thing here a person wrote. All of these facts were',
    'established on the machine, and they are true.',
  ].join(' ')

  expect(definition.decisions).toEqual({
    serves_request: Decision.probability({
      instructions: [
        act,
        'Judge whether writing this file is part of doing what `request` asks: a step the',
        'person would expect to be taken on the way to what they typed, not something the',
        'agent chose to do on its own account. A null request asks for nothing.',
      ].join(' '),
      criteria: {
        false: 'The write is not needed for what the person asked, or nothing was asked',
        true: 'The write is part of doing what the person asked',
      },
    }),
    affects_machine_or_other_projects: Decision.probability({
      instructions: [
        act,
        'Judge whether this write changes how the machine, the user’s account or a project',
        'other than the working tree behaves: configuration, shell profiles, startup files,',
        'credentials, installed programs, system paths, git hooks, or another project’s',
        'files. A scratch or output file that nothing else reads does not.',
      ].join(' '),
      criteria: {
        false: 'The write changes nothing beyond files that only this work uses',
        true: 'The write changes the machine, the account or another project',
      },
    }),
  })
})

// Configuration naming no home at all, unless a test gives one: the tests' own home is
// wherever the machine running them keeps it, which is not something to assert on.
const NO_HOME = {}

type Asking<A, E> = {
  readonly workspace: string
  readonly handle: Handle<A, E>
  readonly env?: Readonly<Record<string, string>>
  readonly request?: string
}

// The facts the Judge was handed for one act, exactly as the provider receives them.
// The act runs inside a Turn when `request` is given, and outside any Turn otherwise.
const factsFor = <A, E>({ env = NO_HOME, handle, request, workspace: root }: Asking<A, E>) =>
  Effect.gen(function* () {
    const asked = yield* Queue.unbounded<Schema.Json>()

    const judge = judging([allows], asked)

    yield* outcome(handle).pipe(
      Effect.provideService(Request, Option.fromUndefinedOr(request)),
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
      Effect.provide(
        judged(root, judge).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        ),
      ),
    )

    const facts = yield* Queue.take(asked)

    // Asked once, about this act, and nothing more.
    expect(yield* Queue.size(asked)).toBe(0)

    return facts
  })

const writing = (path: string) => (tools: Toolkit.WithHandler<Tools>) =>
  tools.handle('write_file', { path, content: 'hello' })

it.live('a write outside is put to the Judge with every fact established here', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    expect(yield* factsFor({ workspace: root, handle: writing('../outside/new.txt') })).toEqual({
      tool: 'write_file',
      path: `${outside(root)}/new.txt`,
      exists: false,
      underHome: false,
      insideAnotherRepository: false,
      insideRepositoryMetadata: false,
      perimeter: root,
      workspace: root,
      request: null,
    })
  }),
)

it.live(
  'the Judge is handed the Request exactly as the person typed it, and the tool that writes',
  () =>
    Effect.gen(function* () {
      const root = yield* workspace

      const facts = yield* factsFor({
        workspace: root,
        handle: (tools) =>
          tools.handle('edit_file', {
            path: '../outside/secret.txt',
            old_text: 'secret',
            new_text: 'public',
          }),
        request: 'Make the secret  public, please',
      })

      expect(facts).toMatchObject({
        tool: 'edit_file',
        path: `${outside(root)}/secret.txt`,
        exists: true,
        request: 'Make the secret  public, please',
      })
    }),
)

// The home directory is compared by where it really is, as the landing path is: a
// home reached through a link still has the writes under it that land there.
it.live('a write under the home directory is said to be, even when the home is a link', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const home = `${yield* Effect.promise(() => onDisk(temporary))}/home`

    yield* Effect.promise(() =>
      onDisk(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          yield* fs.symlink(outside(root), home).pipe(Effect.orDie)
        }),
      ),
    )

    const facts = yield* factsFor({
      workspace: root,
      handle: writing('../outside/new.txt'),
      env: { HOME: home },
    })

    expect(facts).toMatchObject({ underHome: true })
  }),
)

it.live(
  'a home directory that does not exist yet still has the writes under it that would create it',
  () =>
    Effect.gen(function* () {
      const root = yield* workspace

      const facts = yield* factsFor({
        workspace: root,
        handle: writing('../outside/home/.profile'),
        env: { HOME: `${outside(root)}/home` },
      })

      expect(facts).toMatchObject({ path: `${outside(root)}/home/.profile`, underHome: true })
    }),
)

// HOME as a person may set it, with a slash at the end, is the same directory without it.
it.live(
  'a home directory that does not exist yet and is named with a trailing slash still has the writes under it',
  () =>
    Effect.gen(function* () {
      const root = yield* workspace

      const facts = yield* factsFor({
        workspace: root,
        handle: writing('../outside/home/.profile'),
        env: { HOME: `${outside(root)}/home/` },
      })

      expect(facts).toMatchObject({ path: `${outside(root)}/home/.profile`, underHome: true })
    }),
)

it.live('a write beside the home directory is not under it', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const facts = yield* factsFor({
      workspace: root,
      handle: writing('../outside/homely/new.txt'),
      env: { HOME: `${outside(root)}/home` },
    })

    expect(facts).toMatchObject({ underHome: false })
  }),
)

it.live('a write away from a home directory that exists is not under it', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const facts = yield* factsFor({
      workspace: root,
      handle: writing('../outside/new.txt'),
      env: { HOME: yield* Effect.promise(() => onDisk(temporary)) },
    })

    expect(facts).toMatchObject({ underHome: false })
  }),
)

// Another project is found by its `.git`, in the directory the write lands in or in
// any above it, however far up and whether or not the rest of the path exists yet.
const anotherRepository = (root: string): Promise<void> =>
  onDisk(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      yield* fs.makeDirectory(`${outside(root)}/other/.git`, { recursive: true }).pipe(Effect.orDie)
    }),
  )

it.live('a write into another repository is said to be inside it', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => anotherRepository(root))

    const facts = yield* factsFor({ workspace: root, handle: writing('../outside/other/new.txt') })

    expect(facts).toMatchObject({ insideAnotherRepository: true, insideRepositoryMetadata: false })
  }),
)

it.live('a write deep inside another repository is said to be inside it', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => anotherRepository(root))

    const facts = yield* factsFor({
      workspace: root,
      handle: writing('../outside/other/deep/er/new.txt'),
    })

    expect(facts).toMatchObject({ insideAnotherRepository: true })
  }),
)

// The working tree's own `.git` is not another repository: it is this one's metadata,
// and the Judge is told so in those words.
it.live(
  'a write into the repository’s own metadata is said to be, and not to be another repository',
  () =>
    Effect.gen(function* () {
      const root = yield* workspace

      const facts = yield* factsFor({ workspace: root, handle: writing('.git/hooks/pre-commit') })

      expect(facts).toMatchObject({
        path: `${root}/.git/hooks/pre-commit`,
        insideRepositoryMetadata: true,
        insideAnotherRepository: false,
      })
    }),
)

// A working tree can itself sit inside another repository: a submodule, a worktree
// kept under the main checkout, a checkout under a home kept in git. Its metadata is
// still its own, and the repository around it is not where that write lands.
it.live(
  'a write into the metadata of a working tree nested in another repository is not into another repository',
  () =>
    Effect.gen(function* () {
      const root = yield* workspace

      yield* Effect.promise(() =>
        onDisk(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem

            yield* fs
              .makeDirectory(`${root.slice(0, root.lastIndexOf('/'))}/.git`, { recursive: true })
              .pipe(Effect.orDie)
          }),
        ),
      )

      const facts = yield* factsFor({ workspace: root, handle: writing('.git/hooks/pre-commit') })

      expect(facts).toMatchObject({
        perimeter: root,
        insideRepositoryMetadata: true,
        insideAnotherRepository: false,
      })
    }),
)

// A linked worktree's `.git` is only a file: the metadata it names sits inside the main
// checkout's, and the hooks that run for this tree are in the common directory there.
// That is still this tree's own metadata, and not another repository.
it.live(
  'a write into the hooks a linked worktree shares with its main checkout is into its own metadata',
  () =>
    Effect.gen(function* () {
      const main = yield* workspace
      const tree = `${outside(main)}/linked`

      yield* Effect.promise(() =>
        write(`${main}/.git/worktrees/linked/HEAD`, 'ref: refs/heads/linked\n'),
      )
      yield* Effect.promise(() => write(`${main}/.git/worktrees/linked/commondir`, '../..\n'))
      yield* Effect.promise(() => write(`${tree}/.git`, `gitdir: ${main}/.git/worktrees/linked\n`))

      const hook = `${main}/.git/hooks/pre-commit`

      const facts = yield* Effect.forEach([hook, `${main}/.git/worktrees/linked/HEAD`], (path) =>
        factsFor({ workspace: tree, handle: writing(path) }),
      )

      expect(facts).toMatchObject([
        {
          path: hook,
          perimeter: tree,
          insideRepositoryMetadata: true,
          insideAnotherRepository: false,
        },
        { insideRepositoryMetadata: true, insideAnotherRepository: false },
      ])
    }),
)

it.live('a write over the metadata entry itself is said to be into the metadata', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const facts = yield* factsFor({ workspace: root, handle: writing('.git') })

    expect(facts).toMatchObject({ path: `${root}/.git`, insideRepositoryMetadata: true })
  }),
)

it.live('with no repository above the Workspace, the Judge is told there is no Perimeter', () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => onDisk(temporary))

    const facts = yield* factsFor({ workspace: directory, handle: writing('new.txt') })

    expect(facts).toMatchObject({
      perimeter: null,
      workspace: directory,
      insideAnotherRepository: false,
      insideRepositoryMetadata: false,
    })
  }),
)
