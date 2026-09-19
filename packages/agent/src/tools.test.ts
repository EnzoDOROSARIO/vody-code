import { BunServices } from '@effect/platform-bun'
import { afterEach, expect, test } from 'bun:test'
import { Effect, FileSystem, Predicate, Stream } from 'effect'

import type { AiError, Toolkit } from 'effect/unstable/ai'

import { services } from './testing.ts'
import { FileSystemRefused, TextNotFound, toolkit } from './tools.ts'

type Tools = (typeof toolkit)['tools']

const bases: Array<string> = []

const onDisk = <A>(effect: Effect.Effect<A, never, FileSystem.FileSystem>): Promise<A> =>
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

const workspace = (): Promise<string> =>
  onDisk(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const base = yield* fs.makeTempDirectory({ prefix: 'vody-tools-' }).pipe(Effect.orDie)

      bases.push(base)

      yield* Effect.promise(() => Bun.write(`${base}/work/inside/keep.txt`, 'kept'))
      yield* Effect.promise(() => Bun.write(`${base}/outside/secret.txt`, 'secret'))

      return `${base}/work`
    }),
  )

afterEach(() =>
  onDisk(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      for (const base of bases.splice(0)) {
        yield* fs.remove(base, { recursive: true, force: true }).pipe(Effect.orDie)
      }
    }),
  ),
)

const call = <A, E>(
  root: string,
  handle: (
    tools: Toolkit.WithHandler<Tools>,
  ) => Effect.Effect<Stream.Stream<A, E>, AiError.AiError>,
): Promise<A> => {
  const program = Effect.gen(function* () {
    const results = yield* Stream.runCollect(yield* handle(yield* toolkit))

    const last = results[results.length - 1]

    return last === undefined ? yield* Effect.die(new Error('the tool produced no result')) : last
  })

  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
  return Effect.runPromise(program.pipe(Effect.provide(services(root))))
}

test('read_file returns what is in the file', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'inside/keep.txt' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('kept')
})

test('read_file counts a trailing newline as ending a line, not starting one', async () => {
  const root = await workspace()

  await Bun.write(`${root}/three.txt`, 'a\nb\nc\n')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'three.txt', limit: 3 }),
  )

  expect(outcome.result).toBe('a\nb\nc\n')
})

test('read_file rejects a limit of zero rather than returning nothing', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'inside/keep.txt', limit: 0 }),
  )

  expect(outcome.isFailure).toBe(true)
})

test('read_file stops at the line limit and says how much it left', async () => {
  const root = await workspace()

  await Bun.write(`${root}/long.txt`, 'a\nb\nc\nd')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'long.txt', limit: 2 }),
  )

  expect(outcome.result).toBe('a\nb\n... (2 more lines)')
})

test('read_file reaches outside the workspace, the way bash can', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: '../outside/secret.txt' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('secret')
})

test('read_file takes an absolute path as it is given', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: `${root}/../outside/secret.txt` }),
  )

  expect(outcome.result).toBe('secret')
})

test('read_file reports a file that is not there', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('read_file', { path: 'missing.txt' }))

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileSystemRefused)
})

test('write_file creates the parent directories it needs', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'a/b/new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(await Bun.file(`${root}/a/b/new.txt`).text()).toBe('hello')
})

test('write_file reports the byte length, not the character count', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'emoji.txt', content: 'é🙂' }),
  )

  expect(outcome.result).toBe('Wrote 6 bytes to emoji.txt')
})

test('write_file reports a parent that cannot be made a directory', async () => {
  const root = await workspace()

  await Bun.write(`${root}/blocker`, 'not a directory')

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'blocker/new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileSystemRefused)
})

test('write_file resolves a relative path against the workspace', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: '../outside/new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(await Bun.file(`${root}/../outside/new.txt`).text()).toBe('hello')
})

test('edit_file replaces the first occurrence and leaves the rest alone', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one two one')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', {
      path: 'edit.txt',
      old_text: 'one',
      new_text: 'ONE',
    }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('ONE two one')
})

test('edit_file inserts the replacement literally, dollar signs and all', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'before')

  await call(root, (tools) =>
    tools.handle('edit_file', { path: 'edit.txt', old_text: 'before', new_text: '$& $1 $$' }),
  )

  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('$& $1 $$')
})

test('edit_file leaves the file untouched when the text is not there', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one two')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', {
      path: 'edit.txt',
      old_text: 'three',
      new_text: 'four',
    }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(TextNotFound)
  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('one two')
})

test('glob finds files recursively, in order', async () => {
  const root = await workspace()

  await Bun.write(`${root}/b.ts`, '')
  await Bun.write(`${root}/inside/a.ts`, '')

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '**/*.ts' }))

  expect(outcome.result).toBe('b.ts\ninside/a.ts')
})

test('glob cuts a long list short and says it did', async () => {
  const root = await workspace()

  await Promise.all(
    Array.from({ length: 201 }, (_, index) =>
      Bun.write(`${root}/many/${String(index).padStart(3, '0')}.log`, ''),
    ),
  )

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: 'many/*.log' }))

  const lines = Predicate.isString(outcome.result) ? outcome.result.split('\n') : []

  expect(lines).toHaveLength(201)
  expect(lines[0]).toBe('many/000.log')
  expect(lines[199]).toBe('many/199.log')
  expect(lines[200]).toBe('... (more matches omitted; narrow the pattern)')
})

test('glob says so when nothing matches', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '**/*.nothing' }))

  expect(outcome.result).toBe('(no matches)')
})

test('glob matches relative to the workspace, and may reach past it', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '../outside/*.txt' }))

  expect(outcome.result).toBe('../outside/secret.txt')
})

test('bash runs in the workspace', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: 'cat inside/keep.txt' }),
  )

  expect(outcome.result).toBe('kept')
})
