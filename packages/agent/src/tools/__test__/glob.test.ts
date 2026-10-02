import { afterEach, expect, it } from '@effect/vitest'
import { Effect, FileSystem } from 'effect'

import { call, text, touch } from './harness.ts'
import { onDisk, removeWorkspaces, workspace, write } from '#__test__/testing.ts'

afterEach(removeWorkspaces)

it.live('glob finds files recursively, most recently modified first', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => write(`${root}/older.ts`, ''))
    yield* Effect.promise(() => write(`${root}/inside/newer.ts`, ''))

    yield* touch(`${root}/older.ts`, '2020-01-01T00:00:00Z')
    yield* touch(`${root}/inside/newer.ts`, '2024-01-01T00:00:00Z')

    const outcome = yield* call(root, (tools) => tools.handle('glob', { pattern: '**/*.ts' }))

    expect(outcome.result).toBe('inside/newer.ts\nolder.ts')
  }),
)

it.live('glob returns files, not the directories on the way to them', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* call(root, (tools) => tools.handle('glob', { pattern: '*' }))

    expect(outcome.result).toBe('(no matches)')
  }),
)

it.live('glob skips what git ignores', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    // The workspace is already a repository, so git has a say here.
    yield* Effect.promise(() => write(`${root}/.gitignore`, 'build/\n'))
    yield* Effect.promise(() => write(`${root}/build/generated.ts`, ''))
    yield* Effect.promise(() => write(`${root}/kept.ts`, ''))

    const outcome = yield* call(root, (tools) => tools.handle('glob', { pattern: '**/*.ts' }))

    expect(outcome.result).toBe('kept.ts')
  }),
)

it.live('glob skips node_modules even when git does not ignore it', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => write(`${root}/node_modules/dependency/index.ts`, ''))
    yield* Effect.promise(() => write(`${root}/mine.ts`, ''))

    const outcome = yield* call(root, (tools) => tools.handle('glob', { pattern: '**/*.ts' }))

    expect(outcome.result).toBe('mine.ts')
  }),
)

// A workspace need not be a repository at all, and glob asks git what is ignored, so
// the always-excluded list has to hold without a repository to ask.
it.live('glob skips node_modules where there is no repository to ask', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() =>
      onDisk(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          yield* fs.remove(`${root}/.git`, { recursive: true }).pipe(Effect.orDie)
        }),
      ),
    )

    yield* Effect.promise(() => write(`${root}/node_modules/dependency/index.ts`, ''))
    yield* Effect.promise(() => write(`${root}/mine.ts`, ''))

    const outcome = yield* call(root, (tools) => tools.handle('glob', { pattern: '**/*.ts' }))

    expect(outcome.result).toBe('mine.ts')
  }),
)

it.live('glob still looks inside node_modules when the pattern names it', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() => write(`${root}/node_modules/dependency/index.ts`, ''))

    const outcome = yield* call(root, (tools) =>
      tools.handle('glob', { pattern: 'node_modules/**/*.ts' }),
    )

    expect(outcome.result).toBe('node_modules/dependency/index.ts')
  }),
)

it.live('glob cuts a long list short and says it did', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    yield* Effect.promise(() =>
      Promise.all(
        Array.from({ length: 201 }, (_, index) =>
          write(`${root}/many/${String(index).padStart(3, '0')}.log`, ''),
        ),
      ),
    )

    const outcome = yield* call(root, (tools) => tools.handle('glob', { pattern: 'many/*.log' }))

    const lines = text(outcome.result).split('\n')

    expect(lines).toHaveLength(201)
    expect(lines[200]).toBe('... (1 more matches omitted, oldest first; narrow the pattern)')
  }),
)

it.live('glob says so when nothing matches', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* call(root, (tools) => tools.handle('glob', { pattern: '**/*.nothing' }))

    expect(outcome.result).toBe('(no matches)')
  }),
)

it.live('glob matches relative to the workspace, and may reach past it', () =>
  Effect.gen(function* () {
    const root = yield* workspace

    const outcome = yield* call(root, (tools) =>
      tools.handle('glob', { pattern: '../outside/*.txt' }),
    )

    expect(outcome.result).toBe('../outside/secret.txt')
  }),
)
