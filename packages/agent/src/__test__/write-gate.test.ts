import { afterEach, expect, it } from '@effect/vitest'
import { Effect, FileSystem, Predicate, Queue } from 'effect'
import type { Layer, Schema } from 'effect'

import { answering, judging } from './judging.ts'
import {
  fileExists,
  judged,
  onDisk,
  outside,
  readText,
  removeWorkspaces,
  temporary,
  workspace,
  write,
} from './testing.ts'
import { ActRefused } from '#tools/index.ts'
import { call, run } from '#tools/__test__/harness.ts'

import type { Reply } from './judging.ts'
import type { Judge } from '#judge.ts'

afterEach(removeWorkspaces)

// The Judge's answers about a write, question by question: how likely it serves the
// Request, and how likely it affects the machine or other projects.
const answers = (serves: number, affects: number): Reply =>
  answering(
    new Map([
      ['serves_request', serves],
      ['affects_machine_or_other_projects', affects],
    ]),
  )

const judgedAs = (serves: number, affects: number): Layer.Layer<Judge> =>
  judging([answers(serves, affects)])

// A write past the root, into the fixture beside the working tree, with the Judge
// answering as `judge` does.
const writeOutside = (root: string, judge: Layer.Layer<Judge>) =>
  run(judged(root, judge), (tools) =>
    tools.handle('write_file', { path: '../outside/new.txt', content: 'hello' }),
  )

// Two links, one each way: `link` inside the tree leads to the outside fixture, and
// `outside/into` leads back to `inside`. Where a write lands is what the Gate measures,
// so a path written through either lands on the far side of it.
const linked = (root: string): Promise<void> =>
  onDisk(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      yield* fs.symlink(outside(root), `${root}/link`).pipe(Effect.orDie)
      yield* fs.symlink(`${root}/inside`, `${outside(root)}/into`).pipe(Effect.orDie)
    }),
  )

it.live('write_file inside the Perimeter happens exactly as it did', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* call(root, (tools) =>
      tools.handle('write_file', { path: 'inside/new.txt', content: 'hello' }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(yield* Effect.promise(() => readText(`${root}/inside/new.txt`))).toBe('hello')
  }),
)

// A Judge that would refuse anything, and notes whenever it is asked: writes inside
// that went ahead without a single question show the Judge was never consulted.
it.live('a write inside the Perimeter never reaches the Judge', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const asked = yield* Queue.unbounded<Schema.Json>()

    const refusing = judging([answers(0, 1)], asked)

    const wrote = yield* run(judged(root, refusing), (tools) =>
      tools.handle('write_file', { path: 'inside/new.txt', content: 'hello' }),
    )

    const edited = yield* run(judged(root, refusing), (tools) =>
      tools.handle('edit_file', { path: 'inside/keep.txt', old_text: 'kept', new_text: 'edited' }),
    )

    expect(wrote.isFailure).toBe(false)
    expect(edited.isFailure).toBe(false)
    expect(yield* Effect.promise(() => readText(`${root}/inside/keep.txt`))).toBe('edited')
    expect(yield* Queue.size(asked)).toBe(0)
  }),
)

it.live(
  'a write outside the Perimeter that serves the Request goes ahead, however much it touches',
  () =>
    Effect.gen(function* () {
      const root = yield* workspace

      const outcome = yield* writeOutside(root, judgedAs(0.9, 0.8))

      expect(outcome.isFailure).toBe(false)
      expect(yield* Effect.promise(() => readText(`${outside(root)}/new.txt`))).toBe('hello')
    }),
)

it.live(
  'a write outside the Perimeter unrelated to the Request does not happen, and says why',
  () =>
    Effect.gen(function* () {
      const root = yield* workspace

      const outcome = yield* writeOutside(root, judgedAs(0.1, 0.8))

      expect(outcome.isFailure).toBe(true)
      expect(outcome.result).toBeInstanceOf(ActRefused)
      // The refusal is the only account anyone gets of it, so it names the path as written,
      // where that leads, and every axis that tripped with its answer and its line.
      expect(outcome.result).toMatchObject({
        tripped: [
          { axis: 'serves_request', probability: 0.1, line: 'low', threshold: 0.3 },
          {
            axis: 'affects_machine_or_other_projects',
            probability: 0.8,
            line: 'high',
            threshold: 0.7,
          },
        ],
        reason: `write_file will not write ../outside/new.txt: it would land at ${outside(root)}/new.txt, outside the working tree at ${root}, and the Judge's answers refuse it (serves_request at 0.1, below 0.3; affects_machine_or_other_projects at 0.8, at or above 0.7). The refusal is final, so do not try the same write again: do the work another way, or tell the person what you meant to write and why`,
      })
      // What the model is handed is the refusal encoded, and it carries the same numbers.
      expect(Predicate.isTagged(outcome.encodedResult, 'ActRefused')).toBe(true)
      expect(outcome.encodedResult).toMatchObject({
        tripped: [
          { axis: 'serves_request', probability: 0.1, line: 'low', threshold: 0.3 },
          {
            axis: 'affects_machine_or_other_projects',
            probability: 0.8,
            line: 'high',
            threshold: 0.7,
          },
        ],
      })
      expect(yield* Effect.promise(() => fileExists(`${outside(root)}/new.txt`))).toBe(false)
    }),
)

it.live('a write outside the Perimeter that harms nothing goes ahead even unrequested', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* writeOutside(root, judgedAs(0.1, 0.2))

    expect(outcome.isFailure).toBe(false)
    expect(yield* Effect.promise(() => readText(`${outside(root)}/new.txt`))).toBe('hello')
  }),
)

it.live('a write in the absolute band is refused even when it is plainly what was asked', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* writeOutside(root, judgedAs(1, 0.97))

    expect(outcome.isFailure).toBe(true)
    // Only the band tripped: the alignment was not low, so it took no part.
    expect(outcome.result).toMatchObject({
      tripped: [
        {
          axis: 'affects_machine_or_other_projects',
          probability: 0.97,
          line: 'absolute',
          threshold: 0.95,
        },
      ],
      reason: expect.stringContaining(
        '(affects_machine_or_other_projects at 0.97, at or above the absolute band of 0.95)',
      ),
    })
    expect(yield* Effect.promise(() => fileExists(`${outside(root)}/new.txt`))).toBe(false)
  }),
)

it.live(
  'a write in the absolute band and unrequested names the low alignment beside the band',
  () =>
    Effect.gen(function* () {
      const root = yield* workspace

      const outcome = yield* writeOutside(root, judgedAs(0.2, 0.99))

      expect(outcome.result).toMatchObject({
        tripped: [
          { axis: 'serves_request', probability: 0.2, line: 'low', threshold: 0.3 },
          {
            axis: 'affects_machine_or_other_projects',
            probability: 0.99,
            line: 'absolute',
            threshold: 0.95,
          },
        ],
      })
    }),
)

// Each line with an answer just below it, exactly on it, and just above it, and each of
// them decided both ways across the three: a comparison off by one flips exactly one.
// The alignment's line is crossed with a danger high enough to count, the danger's with
// an alignment low enough to let it, and the band's with an alignment as high as it goes.
const boundaries: ReadonlyArray<readonly [string, number, number, boolean]> = [
  ['an alignment just below its line refuses', 0.29, 0.7, false],
  ['an alignment exactly on its line allows', 0.3, 0.7, true],
  ['an alignment just above its line allows', 0.31, 0.7, true],
  ['a danger just below high allows', 0.1, 0.69, true],
  ['a danger exactly at high refuses', 0.1, 0.7, false],
  ['a danger just above high refuses', 0.1, 0.71, false],
  ['a danger just below the absolute band allows what was asked', 1, 0.94, true],
  ['a danger exactly at the absolute band refuses what was asked', 1, 0.95, false],
  ['a danger just above the absolute band refuses what was asked', 1, 0.96, false],
]

it.live.each(boundaries)('%s', ([, serves, affects, allowed]) =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* writeOutside(root, judgedAs(serves, affects))

    expect(outcome.isFailure).toBe(!allowed)
    expect(yield* Effect.promise(() => fileExists(`${outside(root)}/new.txt`))).toBe(allowed)
  }),
)

it.live('edit_file outside the Perimeter, refused, leaves the file as it was', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* run(judged(root, judgedAs(0, 0.9)), (tools) =>
      tools.handle('edit_file', {
        path: '../outside/secret.txt',
        old_text: 'secret',
        new_text: 'changed',
      }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(ActRefused)
    expect(outcome.result).toMatchObject({
      reason: expect.stringContaining(
        `edit_file will not write ../outside/secret.txt: it would land at ${outside(root)}/secret.txt`,
      ),
    })
    expect(yield* Effect.promise(() => readText(`${outside(root)}/secret.txt`))).toBe('secret')
  }),
)

it.live('edit_file outside the Perimeter, allowed, edits the file', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* run(judged(root, judgedAs(0.9, 0.1)), (tools) =>
      tools.handle('edit_file', {
        path: '../outside/secret.txt',
        old_text: 'secret',
        new_text: 'changed',
      }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(yield* Effect.promise(() => readText(`${outside(root)}/secret.txt`))).toBe('changed')
  }),
)

it.live(
  'write_file into the repository’s own metadata is judged, and refused when the Judge says so',
  () =>
    Effect.gen(function* () {
      const root = yield* workspace

      const outcome = yield* run(judged(root, judgedAs(0.1, 0.99)), (tools) =>
        tools.handle('write_file', {
          path: '.git/hooks/pre-commit',
          content: '#!/bin/sh\nrm -rf /',
        }),
      )

      expect(outcome.isFailure).toBe(true)
      expect(outcome.result).toBeInstanceOf(ActRefused)
      expect(outcome.result).toMatchObject({
        reason: expect.stringContaining(`it would land at ${root}/.git/hooks/pre-commit`),
      })
      expect(yield* Effect.promise(() => fileExists(`${root}/.git/hooks/pre-commit`))).toBe(false)
    }),
)

// In a linked worktree `.git` is a file naming the repository, so the entry itself is
// as much the repository's as anything under it.
it.live('write_file over the metadata entry itself is judged', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* run(judged(root, judgedAs(0.1, 0.99)), (tools) =>
      tools.handle('write_file', { path: '.git', content: 'gitdir: /elsewhere' }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(ActRefused)
  }),
)

it.live('edit_file inside the repository’s own metadata is judged', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* run(judged(root, judgedAs(0.1, 0.99)), (tools) =>
      tools.handle('edit_file', { path: '.git/HEAD', old_text: 'main', new_text: 'other' }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(ActRefused)
    expect(yield* Effect.promise(() => readText(`${root}/.git/HEAD`))).toBe(
      'ref: refs/heads/main\n',
    )
  }),
)

it.live(
  'write_file through a link inside the tree that leads outside is judged where it lands',
  () =>
    Effect.gen(function* () {
      const root = yield* workspace

      yield* Effect.promise(() => linked(root))

      const outcome = yield* run(judged(root, judgedAs(0.1, 0.99)), (tools) =>
        tools.handle('write_file', { path: 'link/new.txt', content: 'hello' }),
      )

      expect(outcome.isFailure).toBe(true)
      expect(outcome.result).toMatchObject({
        reason: expect.stringContaining(`it would land at ${outside(root)}/new.txt`),
      })
      expect(yield* Effect.promise(() => fileExists(`${outside(root)}/new.txt`))).toBe(false)
    }),
)

it.live('edit_file through a link inside the tree that leads outside is judged', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => linked(root))

    const outcome = yield* run(judged(root, judgedAs(0.1, 0.99)), (tools) =>
      tools.handle('edit_file', { path: 'link/secret.txt', old_text: 'secret', new_text: 'x' }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(ActRefused)
    expect(yield* Effect.promise(() => readText(`${outside(root)}/secret.txt`))).toBe('secret')
  }),
)

// The directories between the link and the file do not exist yet, so the walk to the
// nearest existing ancestor has to pass them on its way to the link.
it.live('write_file below a link that leads outside is judged however deep the new path', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => linked(root))

    const outcome = yield* run(judged(root, judgedAs(0.1, 0.99)), (tools) =>
      tools.handle('write_file', { path: 'link/deep/er/new.txt', content: 'hello' }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toMatchObject({
      reason: expect.stringContaining(`it would land at ${outside(root)}/deep/er/new.txt`),
    })
    expect(yield* Effect.promise(() => fileExists(`${outside(root)}/deep/er/new.txt`))).toBe(false)
  }),
)

it.live('write_file through a link outside the tree that leads inside is allowed unasked', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => linked(root))

    const outcome = yield* run(judged(root, judgedAs(0, 1)), (tools) =>
      tools.handle('write_file', { path: '../outside/into/new.txt', content: 'hello' }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(yield* Effect.promise(() => readText(`${root}/inside/new.txt`))).toBe('hello')
  }),
)

it.live('edit_file through a link outside the tree that leads inside is allowed unasked', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => linked(root))

    const outcome = yield* run(judged(root, judgedAs(0, 1)), (tools) =>
      tools.handle('edit_file', {
        path: '../outside/into/keep.txt',
        old_text: 'kept',
        new_text: 'edited',
      }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(yield* Effect.promise(() => readText(`${root}/inside/keep.txt`))).toBe('edited')
  }),
)

it.live('write_file to a path whose directories do not exist yet is allowed inside the tree', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* call(root, (tools) =>
      tools.handle('write_file', { path: 'inside/deep/er/new.txt', content: 'hello' }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(yield* Effect.promise(() => readText(`${root}/inside/deep/er/new.txt`))).toBe('hello')
  }),
)

it.live(
  'with no repository above the Workspace, every write is judged, and one the Judge allows happens',
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => onDisk(temporary))

      const outcome = yield* run(judged(directory, judgedAs(0.9, 0.1)), (tools) =>
        tools.handle('write_file', { path: 'new.txt', content: 'hello' }),
      )

      expect(outcome.isFailure).toBe(false)
      expect(yield* Effect.promise(() => readText(`${directory}/new.txt`))).toBe('hello')
    }),
)

it.live(
  'with no repository above the Workspace, a write the Judge refuses says there is no working tree',
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() => onDisk(temporary))

      const outcome = yield* run(judged(directory, judgedAs(0.1, 0.8)), (tools) =>
        tools.handle('write_file', { path: 'new.txt', content: 'hello' }),
      )

      expect(outcome.isFailure).toBe(true)
      expect(outcome.result).toMatchObject({
        reason: expect.stringContaining(
          `new.txt, outside any working tree, since none could be found from ${directory}, and the Judge's answers refuse it`,
        ),
      })
      expect(yield* Effect.promise(() => fileExists(`${directory}/new.txt`))).toBe(false)
    }),
)

it.live('with no repository above the Workspace, edit_file is judged too', () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => write(`${directory}/edit.txt`, 'one'))

    const outcome = yield* run(judged(directory, judgedAs(0.1, 0.8)), (tools) =>
      tools.handle('edit_file', { path: 'edit.txt', old_text: 'one', new_text: 'two' }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(ActRefused)
    expect(yield* Effect.promise(() => readText(`${directory}/edit.txt`))).toBe('one')
  }),
)

it.live('with no repository above the Workspace, the agent still reads and searches', () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => write(`${directory}/read.txt`, 'readable'))

    const read = yield* call(directory, (tools) => tools.handle('read_file', { path: 'read.txt' }))

    const found = yield* call(directory, (tools) => tools.handle('glob', { pattern: '*.txt' }))

    expect(read.result).toBe('     1→readable')
    expect(found.result).toBe('read.txt')
  }),
)
