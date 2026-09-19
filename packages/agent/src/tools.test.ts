import { BunServices } from '@effect/platform-bun'
import { afterEach, expect, test } from 'bun:test'
import { DateTime, Effect, FileSystem, Predicate, Stream } from 'effect'

import type { AiError, Tool, Toolkit } from 'effect/unstable/ai'

import { services } from './testing.ts'
import {
  CommandRefused,
  CommandTimedOut,
  FileIsBinary,
  FileNotRead,
  FileSystemRefused,
  TextNotFound,
  TextNotUnique,
  toolkit,
} from './tools.ts'

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

const touch = (target: string, iso: string): Promise<void> =>
  onDisk(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const at = DateTime.toDateUtc(DateTime.makeUnsafe(iso))

      yield* fs.utimes(target, at, at).pipe(Effect.orDie)
    }),
  )

const shell = async (root: string, command: string): Promise<void> => {
  await Bun.$`sh -c ${command}`.cwd(root).quiet()
}

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

type Outcome = Tool.Result<Tools[keyof Tools]>

const text = (result: Outcome): string => (Predicate.isString(result) ? result : '')

const utf8 = (contents: string): Array<number> => [...new TextEncoder().encode(contents)]

const bytesOf = async (target: string): Promise<Array<number>> => [
  ...new Uint8Array(await Bun.file(target).arrayBuffer()),
]

const spillOf = (result: Outcome): string => {
  const named = /full output at (?<at>\S+?)\)/u.exec(text(result))?.groups?.['at']

  if (named === undefined) {
    throw new Error(`no spill file named in: ${text(result).slice(0, 120)}`)
  }

  return named
}

test('read_file numbers the lines it returns', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'inside/keep.txt' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('     1→kept')
})

test('read_file counts a trailing newline as ending a line, not starting one', async () => {
  const root = await workspace()

  await Bun.write(`${root}/three.txt`, 'a\nb\nc\n')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'three.txt', limit: 3 }),
  )

  expect(outcome.result).toBe('     1→a\n     2→b\n     3→c')
})

test('read_file rejects a limit of zero rather than returning nothing', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'inside/keep.txt', limit: 0 }),
  )

  expect(outcome.isFailure).toBe(true)
})

test('read_file stops at the line limit and says where to continue', async () => {
  const root = await workspace()

  await Bun.write(`${root}/long.txt`, 'a\nb\nc\nd')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'long.txt', limit: 2 }),
  )

  expect(outcome.result).toBe('     1→a\n     2→b\n... (2 more lines; continue with offset 3)')
})

test('read_file starts at the offset it is given, numbering from there', async () => {
  const root = await workspace()

  await Bun.write(`${root}/long.txt`, 'a\nb\nc\nd')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'long.txt', offset: 3 }),
  )

  expect(outcome.result).toBe('     3→c\n     4→d')
})

test('read_file pages through a file with offset and limit together', async () => {
  const root = await workspace()

  await Bun.write(`${root}/long.txt`, 'a\nb\nc\nd\ne')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'long.txt', offset: 2, limit: 2 }),
  )

  expect(outcome.result).toBe('     2→b\n     3→c\n... (2 more lines; continue with offset 4)')
})

test('read_file says so when the offset is past the end', async () => {
  const root = await workspace()

  await Bun.write(`${root}/short.txt`, 'a\nb')

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: 'short.txt', offset: 9 }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('(offset 9 is past the end of short.txt, which has 2 lines)')
})

test('read_file marks an empty file rather than returning nothing', async () => {
  const root = await workspace()

  await Bun.write(`${root}/empty.txt`, '')

  const outcome = await call(root, (tools) => tools.handle('read_file', { path: 'empty.txt' }))

  expect(outcome.result).toBe('(empty file)')
})

test('read_file refuses a binary file instead of decoding it to nonsense', async () => {
  const root = await workspace()

  await Bun.write(`${root}/image.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0x0a]))

  const outcome = await call(root, (tools) => tools.handle('read_file', { path: 'image.png' }))

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileIsBinary)
})

test('read_file clips a line too long to be bounded by a line limit', async () => {
  const root = await workspace()

  await Bun.write(`${root}/bundle.js`, 'x'.repeat(5_000_000))

  const outcome = await call(root, (tools) => tools.handle('read_file', { path: 'bundle.js' }))

  expect(outcome.isFailure).toBe(false)
  expect(text(outcome.result)).toEndWith('... (truncated at 100000 characters)')
  expect(text(outcome.result).length).toBeLessThan(101_000)
})

test('read_file reaches outside the workspace, the way bash can', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: '../outside/secret.txt' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('     1→secret')
})

test('read_file takes an absolute path as it is given', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('read_file', { path: `${root}/../outside/secret.txt` }),
  )

  expect(outcome.result).toBe('     1→secret')
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
  expect(outcome.result).toBe('Created a/b/new.txt (5 bytes)')
  expect(await Bun.file(`${root}/a/b/new.txt`).text()).toBe('hello')
})

test('write_file reports the byte length, not the character count', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'emoji.txt', content: 'é🙂' }),
  )

  expect(outcome.result).toBe('Created emoji.txt (6 bytes)')
})

test('write_file will not overwrite a file that was never read', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'inside/keep.txt', content: 'clobbered' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileNotRead)
  expect(await Bun.file(`${root}/inside/keep.txt`).text()).toBe('kept')
})

test('write_file overwrites a file that was read first, and says it did', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(yield* tools.handle('read_file', { path: 'inside/keep.txt' }))

      return yield* tools.handle('write_file', { path: 'inside/keep.txt', content: 'replaced' })
    }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('Overwrote inside/keep.txt (8 bytes)')
  expect(await Bun.file(`${root}/inside/keep.txt`).text()).toBe('replaced')
})

test('write_file will not overwrite on the strength of a read that showed nothing', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(
        yield* tools.handle('read_file', { path: 'inside/keep.txt', offset: 999 }),
      )

      return yield* tools.handle('write_file', { path: 'inside/keep.txt', content: 'clobbered' })
    }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileNotRead)
  expect(await Bun.file(`${root}/inside/keep.txt`).text()).toBe('kept')
})

test('write_file will not overwrite on the strength of a read that showed only part', async () => {
  const root = await workspace()

  await Bun.write(`${root}/long.txt`, 'a\nb\nc\nd')

  const outcome = await call(root, (tools) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(yield* tools.handle('read_file', { path: 'long.txt', limit: 2 }))

      return yield* tools.handle('write_file', { path: 'long.txt', content: 'clobbered' })
    }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileNotRead)
  expect(await Bun.file(`${root}/long.txt`).text()).toBe('a\nb\nc\nd')
})

test('write_file will not overwrite a file that changed after it was read', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(yield* tools.handle('read_file', { path: 'inside/keep.txt' }))

      yield* Effect.promise(() => Bun.write(`${root}/inside/keep.txt`, 'changed elsewhere'))

      yield* Effect.promise(() => touch(`${root}/inside/keep.txt`, '2999-01-01T00:00:00Z'))

      return yield* tools.handle('write_file', { path: 'inside/keep.txt', content: 'clobbered' })
    }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(FileNotRead)
  expect(await Bun.file(`${root}/inside/keep.txt`).text()).toBe('changed elsewhere')
})

test('write_file leaves no temporary file behind', async () => {
  const root = await workspace()

  await call(root, (tools) => tools.handle('write_file', { path: 'new.txt', content: 'hello' }))

  const left = await Array.fromAsync(new Bun.Glob('*').scan({ cwd: root, dot: true }))

  expect(left.filter((entry) => entry.endsWith('.tmp'))).toEqual([])
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

test('edit_file replaces a unique occurrence and shows the edited lines', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one\ntwo\nthree')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'edit.txt', old_text: 'two', new_text: 'TWO' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe(
    'Edited edit.txt (1 replacement)\n     1→one\n     2→TWO\n     3→three',
  )
  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('one\nTWO\nthree')
})

test('edit_file inserts the replacement literally, dollar signs and all', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'before')

  await call(root, (tools) =>
    tools.handle('edit_file', { path: 'edit.txt', old_text: 'before', new_text: '$& $1 $$' }),
  )

  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('$& $1 $$')
})

test('edit_file refuses an ambiguous match rather than picking the first', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one two one')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'edit.txt', old_text: 'one', new_text: 'ONE' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(TextNotUnique)
  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('one two one')
})

test('edit_file changes every occurrence when asked to', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one two one')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', {
      path: 'edit.txt',
      old_text: 'one',
      new_text: 'ONE',
      replace_all: true,
    }),
  )

  expect(text(outcome.result)).toStartWith('Edited edit.txt (2 replacements)')
  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('ONE two ONE')
})

test('edit_file leaves the file untouched when the text is not there', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one two')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'edit.txt', old_text: 'three', new_text: 'four' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(TextNotFound)
  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('one two')
})

test('edit_file rejects an empty old_text instead of prepending', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one two')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'edit.txt', old_text: '', new_text: 'x' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(TextNotFound)
  expect(await Bun.file(`${root}/edit.txt`).text()).toBe('one two')
})

test('edit_file matches old_text written with newlines against a file using CRLF', async () => {
  const root = await workspace()

  await Bun.write(`${root}/crlf.txt`, 'one\r\ntwo\r\nthree\r\n')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', {
      path: 'crlf.txt',
      old_text: 'one\ntwo\n',
      new_text: 'one\nTWO\n',
    }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(await Bun.file(`${root}/crlf.txt`).text()).toBe('one\r\nTWO\r\nthree\r\n')
})

test('edit_file shows the edited lines without the carriage returns around them', async () => {
  const root = await workspace()

  await Bun.write(`${root}/crlf.txt`, 'one\r\ntwo\r\nthree\r\n')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'crlf.txt', old_text: 'two', new_text: 'TWO' }),
  )

  expect(outcome.result).toBe(
    'Edited crlf.txt (1 replacement)\n     1→one\n     2→TWO\n     3→three',
  )
})

test('edit_file leaves a file of mixed line endings alone outside the part it changed', async () => {
  const root = await workspace()

  await Bun.write(`${root}/mixed.txt`, 'one\r\ntwo\nthree\r\n')

  await call(root, (tools) =>
    tools.handle('edit_file', { path: 'mixed.txt', old_text: 'three', new_text: 'THREE' }),
  )

  expect(await Bun.file(`${root}/mixed.txt`).text()).toBe('one\r\ntwo\nTHREE\r\n')
})

test('edit_file reaches every occurrence of mixed endings when replacing all', async () => {
  const root = await workspace()

  await Bun.write(`${root}/n.txt`, 'a\r\nX\r\nb\r\nc\nX\nd\n')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', {
      path: 'n.txt',
      old_text: 'X\n',
      new_text: 'Y\n',
      replace_all: true,
    }),
  )

  expect(text(outcome.result)).toStartWith('Edited n.txt (2 replacements)')
  expect(await Bun.file(`${root}/n.txt`).text()).toBe('a\r\nY\r\nb\r\nc\nY\nd\n')
})

test('edit_file counts occurrences of either framing before calling a match unique', async () => {
  const root = await workspace()

  await Bun.write(`${root}/n.txt`, 'a\r\nX\r\nb\r\nc\nX\nd\n')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'n.txt', old_text: 'X\n', new_text: 'Y\n' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(TextNotUnique)
  expect(outcome.result).toMatchObject({ occurrences: 2 })
  expect(await Bun.file(`${root}/n.txt`).text()).toBe('a\r\nX\r\nb\r\nc\nX\nd\n')
})

test('edit_file keeps the byte order mark a file opened with', async () => {
  const root = await workspace()

  await Bun.write(`${root}/bom.txt`, '\uFEFFone\ntwo\n')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'bom.txt', old_text: 'two', new_text: 'TWO' }),
  )

  expect(outcome.isFailure).toBe(false)
  // `Bun.file().text()` drops a leading mark, so read the bytes to see it survived.
  expect(await bytesOf(`${root}/bom.txt`)).toEqual([0xef, 0xbb, 0xbf, ...utf8('one\nTWO\n')])
})

test('edit_file does not match a byte order mark the model could not have seen', async () => {
  const root = await workspace()

  await Bun.write(`${root}/bom.txt`, '\uFEFFone\n')

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'bom.txt', old_text: 'one', new_text: 'ONE' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(await bytesOf(`${root}/bom.txt`)).toEqual([0xef, 0xbb, 0xbf, ...utf8('ONE\n')])
})

test('edit_file lets write_file overwrite afterwards, having read the file itself', async () => {
  const root = await workspace()

  await Bun.write(`${root}/edit.txt`, 'one')

  const outcome = await call(root, (tools) =>
    Effect.gen(function* () {
      yield* Stream.runDrain(
        yield* tools.handle('edit_file', { path: 'edit.txt', old_text: 'one', new_text: 'two' }),
      )

      return yield* tools.handle('write_file', { path: 'edit.txt', content: 'three' })
    }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('Overwrote edit.txt (5 bytes)')
})

test('glob finds files recursively, most recently modified first', async () => {
  const root = await workspace()

  await Bun.write(`${root}/older.ts`, '')
  await Bun.write(`${root}/inside/newer.ts`, '')

  await touch(`${root}/older.ts`, '2020-01-01T00:00:00Z')
  await touch(`${root}/inside/newer.ts`, '2024-01-01T00:00:00Z')

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '**/*.ts' }))

  expect(outcome.result).toBe('inside/newer.ts\nolder.ts')
})

test('glob returns files, not the directories on the way to them', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '*' }))

  expect(outcome.result).toBe('(no matches)')
})

test('glob skips what git ignores', async () => {
  const root = await workspace()

  await shell(root, 'git init -q')

  await Bun.write(`${root}/.gitignore`, 'build/\n')
  await Bun.write(`${root}/build/generated.ts`, '')
  await Bun.write(`${root}/kept.ts`, '')

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '**/*.ts' }))

  expect(outcome.result).toBe('kept.ts')
})

test('glob skips node_modules even where git has no say', async () => {
  const root = await workspace()

  await Bun.write(`${root}/node_modules/dependency/index.ts`, '')
  await Bun.write(`${root}/mine.ts`, '')

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: '**/*.ts' }))

  expect(outcome.result).toBe('mine.ts')
})

test('glob still looks inside node_modules when the pattern names it', async () => {
  const root = await workspace()

  await Bun.write(`${root}/node_modules/dependency/index.ts`, '')

  const outcome = await call(root, (tools) =>
    tools.handle('glob', { pattern: 'node_modules/**/*.ts' }),
  )

  expect(outcome.result).toBe('node_modules/dependency/index.ts')
})

test('glob cuts a long list short and says it did', async () => {
  const root = await workspace()

  await Promise.all(
    Array.from({ length: 201 }, (_, index) =>
      Bun.write(`${root}/many/${String(index).padStart(3, '0')}.log`, ''),
    ),
  )

  const outcome = await call(root, (tools) => tools.handle('glob', { pattern: 'many/*.log' }))

  const lines = text(outcome.result).split('\n')

  expect(lines).toHaveLength(201)
  expect(lines[200]).toBe('... (1 more matches omitted, oldest first; narrow the pattern)')
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

test('bash runs in the workspace and reports a clean exit', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: 'cat inside/keep.txt' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('exit 0\nkept')
})

test('bash reports a command that failed', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: 'echo trouble; exit 3' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(outcome.result).toBe('exit 3\ntrouble\n')
})

test('bash includes what a command wrote to stderr', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: 'echo complaint >&2' }),
  )

  expect(outcome.result).toBe('exit 0\ncomplaint\n')
})

test('bash marks a command that printed nothing', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('bash', { command: 'true' }))

  expect(outcome.result).toBe('exit 0\n(no output)')
})

test('bash closes stdin, so a command that reads it ends instead of hanging', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('bash', { command: 'cat' }))

  expect(outcome.result).toBe('exit 0\n(no output)')
})

test('bash kills a command that outstays its timeout, keeping what it printed', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: 'echo starting; sleep 30', timeout_seconds: 1 }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(CommandTimedOut)
  expect(outcome.result).toMatchObject({ output: 'starting\n', seconds: 1 })
})

test('bash keeps the end of output that would otherwise flood the context', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: `seq 1 20000; echo done` }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(text(outcome.result)).toEndWith('done\n')
  expect(text(outcome.result)).toContain('earlier characters omitted')
  expect(text(outcome.result).length).toBeLessThan(31_200)
})

test('bash writes the whole of a truncated output to a file it names', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: `seq 1 20000; echo done` }),
  )

  const whole = await Bun.file(spillOf(outcome.result)).text()

  expect(whole).toStartWith('1\n2\n3\n')
  expect(whole).toEndWith('20000\ndone\n')
})

test('bash keeps a whole tail even when one chunk is larger than the tail', async () => {
  const root = await workspace()

  // A single line far longer than the budget arrives in chunks bigger than the tail
  // itself, so trimming a whole chunk at a time would leave almost nothing behind.
  const outcome = await call(root, (tools) =>
    tools.handle('bash', { command: `head -c 400000 /dev/zero | tr '\\0' 'x'; echo done` }),
  )

  expect(text(outcome.result)).toEndWith('done\n')
  expect(text(outcome.result).length).toBeGreaterThan(30_000)

  expect(Bun.file(spillOf(outcome.result)).size).toBe(400_000 + 'done\n'.length)
})

test('bash names no file when the output fit', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) => tools.handle('bash', { command: 'echo small' }))

  expect(outcome.result).toBe('exit 0\nsmall\n')
})

test('bash reports a shell it could not start at all', async () => {
  const root = await workspace()

  await onDisk(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      yield* fs.remove(root, { recursive: true, force: true }).pipe(Effect.orDie)
    }),
  )

  const outcome = await call(root, (tools) => tools.handle('bash', { command: 'echo hello' }))

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(CommandRefused)
})
