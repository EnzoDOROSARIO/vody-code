import { afterEach, expect, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'

import { call, touch } from './harness.ts'
import {
  entriesOf,
  outside,
  readText,
  removeWorkspaces,
  workspace,
  write,
} from '#__test__/testing.ts'
import { FileNotRead, FileSystemRefused } from '#tools/index.ts'

afterEach(removeWorkspaces)

it.live('write_file creates the parent directories it needs', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* call(root, (tools) =>
      tools.handle('write_file', { path: 'a/b/new.txt', content: 'hello' }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(outcome.result).toBe('Created a/b/new.txt (5 bytes)')
    expect(yield* Effect.promise(() => readText(`${root}/a/b/new.txt`))).toBe('hello')
  }),
)

it.live('write_file reports the byte length, not the character count', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* call(root, (tools) =>
      tools.handle('write_file', { path: 'emoji.txt', content: 'é🙂' }),
    )

    expect(outcome.result).toBe('Created emoji.txt (6 bytes)')
  }),
)

it.live('write_file will not overwrite a file that was never read', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* call(root, (tools) =>
      tools.handle('write_file', { path: 'inside/keep.txt', content: 'clobbered' }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(FileNotRead)
    // The refusal is the model's only instruction on what to do instead, and the two
    // ways a write is refused ask for different things.
    expect(outcome.result).toMatchObject({
      reason: expect.stringContaining('unseen — read_file all of it first'),
    })
    expect(yield* Effect.promise(() => readText(`${root}/inside/keep.txt`))).toBe('kept')
  }),
)

it.live('write_file overwrites a file that was read first, and says it did', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* call(root, (tools) =>
      Effect.gen(function* () {
        yield* Stream.runDrain(yield* tools.handle('read_file', { path: 'inside/keep.txt' }))

        return yield* tools.handle('write_file', { path: 'inside/keep.txt', content: 'replaced' })
      }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(outcome.result).toBe('Overwrote inside/keep.txt (8 bytes)')
    expect(yield* Effect.promise(() => readText(`${root}/inside/keep.txt`))).toBe('replaced')
  }),
)

it.live('write_file will not overwrite on the strength of a read that showed nothing', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* call(root, (tools) =>
      Effect.gen(function* () {
        yield* Stream.runDrain(
          yield* tools.handle('read_file', { path: 'inside/keep.txt', offset: 999 }),
        )

        return yield* tools.handle('write_file', { path: 'inside/keep.txt', content: 'clobbered' })
      }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(FileNotRead)
    expect(yield* Effect.promise(() => readText(`${root}/inside/keep.txt`))).toBe('kept')
  }),
)

it.live('write_file will not overwrite on the strength of a read that showed only part', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => write(`${root}/long.txt`, 'a\nb\nc\nd'))

    const outcome = yield* call(root, (tools) =>
      Effect.gen(function* () {
        yield* Stream.runDrain(yield* tools.handle('read_file', { path: 'long.txt', limit: 2 }))

        return yield* tools.handle('write_file', { path: 'long.txt', content: 'clobbered' })
      }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(FileNotRead)
    expect(yield* Effect.promise(() => readText(`${root}/long.txt`))).toBe('a\nb\nc\nd')
  }),
)

// A read that starts partway down a file reaches its last line and is cut short by
// nothing, so everything but the offset says it was whole. The lines before the offset
// are still unseen, and overwriting on the strength of that read would drop them.
it.live('write_file will not overwrite on the strength of a read that started partway down', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => write(`${root}/three.txt`, 'a\nb\nc\n'))

    const outcome = yield* call(root, (tools) =>
      Effect.gen(function* () {
        yield* Stream.runDrain(yield* tools.handle('read_file', { path: 'three.txt', offset: 2 }))

        return yield* tools.handle('write_file', { path: 'three.txt', content: 'clobbered' })
      }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(FileNotRead)
    expect(outcome.result).toMatchObject({
      reason: expect.stringContaining('unseen — read_file all of it first'),
    })
    expect(yield* Effect.promise(() => readText(`${root}/three.txt`))).toBe('a\nb\nc\n')
  }),
)

it.live('write_file will not overwrite a file that changed after it was read', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* call(root, (tools) =>
      Effect.gen(function* () {
        yield* Stream.runDrain(yield* tools.handle('read_file', { path: 'inside/keep.txt' }))

        yield* Effect.promise(() => write(`${root}/inside/keep.txt`, 'changed elsewhere'))

        yield* touch(`${root}/inside/keep.txt`, '2999-01-01T00:00:00Z')

        return yield* tools.handle('write_file', { path: 'inside/keep.txt', content: 'clobbered' })
      }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(FileNotRead)
    expect(outcome.result).toMatchObject({
      reason: expect.stringContaining('it changed on disk after you read it'),
    })
    expect(yield* Effect.promise(() => readText(`${root}/inside/keep.txt`))).toBe(
      'changed elsewhere',
    )
  }),
)

it.live('write_file leaves no temporary file behind', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* call(root, (tools) => tools.handle('write_file', { path: 'new.txt', content: 'hello' }))

    const left = yield* Effect.promise(() => entriesOf(root))

    expect(left.filter((entry) => entry.endsWith('.tmp'))).toEqual([])
  }),
)

it.live('write_file reports a parent that cannot be made a directory', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => write(`${root}/blocker`, 'not a directory'))

    const outcome = yield* call(root, (tools) =>
      tools.handle('write_file', { path: 'blocker/new.txt', content: 'hello' }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(FileSystemRefused)
  }),
)

// The path is resolved against the Workspace, and that is what puts it outside the
// Perimeter: the fixture past the root is the outside-the-Perimeter case, unchanged.
// The Judge the tests stand up allows it, so the write lands, and where it lands is
// pinned exactly, since resolving against the process's own directory instead would
// also end in `outside/new.txt`.
it.live('write_file resolves a relative path against the workspace, and so lands outside', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* call(root, (tools) =>
      tools.handle('write_file', { path: '../outside/new.txt', content: 'hello' }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(yield* Effect.promise(() => readText(`${outside(root)}/new.txt`))).toBe('hello')
  }),
)
