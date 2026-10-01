import { afterEach, expect, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'
import * as Fs from 'node:fs/promises'

import { call, text } from './harness.ts'
import { readText, removeWorkspaces, workspace, write } from '#__test__/testing.ts'
import { TextNotFound, TextNotUnique } from '#tools/index.ts'

afterEach(removeWorkspaces)

const utf8 = (contents: string): Array<number> => [...new TextEncoder().encode(contents)]

const bytesOf = async (target: string): Promise<Array<number>> => [
  ...new Uint8Array(await Fs.readFile(target)),
]

it.live('edit_file replaces a unique occurrence and shows the edited lines', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/edit.txt`, 'one\ntwo\nthree'))

    const outcome = yield* call(root, (tools) =>
      tools.handle('edit_file', { path: 'edit.txt', old_text: 'two', new_text: 'TWO' }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(outcome.result).toBe(
      'Edited edit.txt (1 replacement)\n     1→one\n     2→TWO\n     3→three',
    )
    expect(yield* Effect.promise(() => readText(`${root}/edit.txt`))).toBe('one\nTWO\nthree')
  }),
)

it.live('edit_file inserts the replacement literally, dollar signs and all', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/edit.txt`, 'before'))

    yield* call(root, (tools) =>
      tools.handle('edit_file', { path: 'edit.txt', old_text: 'before', new_text: '$& $1 $$' }),
    )

    expect(yield* Effect.promise(() => readText(`${root}/edit.txt`))).toBe('$& $1 $$')
  }),
)

it.live('edit_file refuses an ambiguous match rather than picking the first', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/edit.txt`, 'one two one'))

    const outcome = yield* call(root, (tools) =>
      tools.handle('edit_file', { path: 'edit.txt', old_text: 'one', new_text: 'ONE' }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(TextNotUnique)
    // What the model is told to do next: the count it has to disambiguate against, and
    // the two ways out of it.
    expect(outcome.result).toMatchObject({
      reason: expect.stringContaining('found 2 occurrences of old_text in edit.txt'),
    })
    expect(yield* Effect.promise(() => readText(`${root}/edit.txt`))).toBe('one two one')
  }),
)

it.live('edit_file changes every occurrence when asked to', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/edit.txt`, 'one two one'))

    const outcome = yield* call(root, (tools) =>
      tools.handle('edit_file', {
        path: 'edit.txt',
        old_text: 'one',
        new_text: 'ONE',
        replace_all: true,
      }),
    )

    expect(text(outcome.result).startsWith('Edited edit.txt (2 replacements)')).toBe(true)
    expect(yield* Effect.promise(() => readText(`${root}/edit.txt`))).toBe('ONE two ONE')
  }),
)

it.live('edit_file leaves the file untouched when the text is not there', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/edit.txt`, 'one two'))

    const outcome = yield* call(root, (tools) =>
      tools.handle('edit_file', { path: 'edit.txt', old_text: 'three', new_text: 'four' }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(TextNotFound)
    expect(outcome.result).toMatchObject({
      reason: expect.stringContaining('found no occurrence of old_text in edit.txt'),
    })
    expect(yield* Effect.promise(() => readText(`${root}/edit.txt`))).toBe('one two')
  }),
)

it.live('edit_file rejects an empty old_text instead of prepending', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/edit.txt`, 'one two'))

    const outcome = yield* call(root, (tools) =>
      tools.handle('edit_file', { path: 'edit.txt', old_text: '', new_text: 'x' }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(TextNotFound)
    expect(outcome.result).toMatchObject({
      reason: expect.stringContaining('was given an empty old_text'),
    })
    expect(yield* Effect.promise(() => readText(`${root}/edit.txt`))).toBe('one two')
  }),
)

it.live('edit_file matches old_text written with newlines against a file using CRLF', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/crlf.txt`, 'one\r\ntwo\r\nthree\r\n'))

    const outcome = yield* call(root, (tools) =>
      tools.handle('edit_file', {
        path: 'crlf.txt',
        old_text: 'one\ntwo\n',
        new_text: 'one\nTWO\n',
      }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(yield* Effect.promise(() => readText(`${root}/crlf.txt`))).toBe(
      'one\r\nTWO\r\nthree\r\n',
    )
  }),
)

it.live('edit_file shows the edited lines without the carriage returns around them', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/crlf.txt`, 'one\r\ntwo\r\nthree\r\n'))

    const outcome = yield* call(root, (tools) =>
      tools.handle('edit_file', { path: 'crlf.txt', old_text: 'two', new_text: 'TWO' }),
    )

    expect(outcome.result).toBe(
      'Edited crlf.txt (1 replacement)\n     1→one\n     2→TWO\n     3→three',
    )
  }),
)

it.live('edit_file leaves a file of mixed line endings alone outside the part it changed', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/mixed.txt`, 'one\r\ntwo\nthree\r\n'))

    yield* call(root, (tools) =>
      tools.handle('edit_file', { path: 'mixed.txt', old_text: 'three', new_text: 'THREE' }),
    )

    expect(yield* Effect.promise(() => readText(`${root}/mixed.txt`))).toBe('one\r\ntwo\nTHREE\r\n')
  }),
)

it.live('edit_file reaches every occurrence of mixed endings when replacing all', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/n.txt`, 'a\r\nX\r\nb\r\nc\nX\nd\n'))

    const outcome = yield* call(root, (tools) =>
      tools.handle('edit_file', {
        path: 'n.txt',
        old_text: 'X\n',
        new_text: 'Y\n',
        replace_all: true,
      }),
    )

    expect(text(outcome.result).startsWith('Edited n.txt (2 replacements)')).toBe(true)
    expect(yield* Effect.promise(() => readText(`${root}/n.txt`))).toBe('a\r\nY\r\nb\r\nc\nY\nd\n')
  }),
)

it.live('edit_file counts occurrences of either framing before calling a match unique', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/n.txt`, 'a\r\nX\r\nb\r\nc\nX\nd\n'))

    const outcome = yield* call(root, (tools) =>
      tools.handle('edit_file', { path: 'n.txt', old_text: 'X\n', new_text: 'Y\n' }),
    )

    expect(outcome.isFailure).toBe(true)
    expect(outcome.result).toBeInstanceOf(TextNotUnique)
    expect(outcome.result).toMatchObject({ occurrences: 2 })
    expect(yield* Effect.promise(() => readText(`${root}/n.txt`))).toBe('a\r\nX\r\nb\r\nc\nX\nd\n')
  }),
)

it.live('edit_file keeps the byte order mark a file opened with', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/bom.txt`, '\uFEFFone\ntwo\n'))

    const outcome = yield* call(root, (tools) =>
      tools.handle('edit_file', { path: 'bom.txt', old_text: 'two', new_text: 'TWO' }),
    )

    expect(outcome.isFailure).toBe(false)
    // `Bun.file().text()` drops a leading mark, so read the bytes to see it survived.
    expect(yield* Effect.promise(() => bytesOf(`${root}/bom.txt`))).toEqual([
      0xef,
      0xbb,
      0xbf,
      ...utf8('one\nTWO\n'),
    ])
  }),
)

it.live('edit_file does not match a byte order mark the model could not have seen', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/bom.txt`, '\uFEFFone\n'))

    const outcome = yield* call(root, (tools) =>
      tools.handle('edit_file', { path: 'bom.txt', old_text: 'one', new_text: 'ONE' }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(yield* Effect.promise(() => bytesOf(`${root}/bom.txt`))).toEqual([
      0xef,
      0xbb,
      0xbf,
      ...utf8('ONE\n'),
    ])
  }),
)

it.live('edit_file lets write_file overwrite afterwards, having read the file itself', () =>
  Effect.gen(function* () {
    const root = yield* workspace()

    yield* Effect.promise(() => write(`${root}/edit.txt`, 'one'))

    const outcome = yield* call(root, (tools) =>
      Effect.gen(function* () {
        yield* Stream.runDrain(
          yield* tools.handle('edit_file', { path: 'edit.txt', old_text: 'one', new_text: 'two' }),
        )

        return yield* tools.handle('write_file', { path: 'edit.txt', content: 'three' })
      }),
    )

    expect(outcome.isFailure).toBe(false)
    expect(outcome.result).toBe('Overwrote edit.txt (5 bytes)')
  }),
)
