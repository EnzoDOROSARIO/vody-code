import { afterEach, expect, test } from 'bun:test'
import { Effect, FileSystem, Predicate } from 'effect'

import { onDisk, outside, removeWorkspaces, temporary, workspace } from './testing.ts'
import { OutsidePerimeter } from '#tools/index.ts'
import { call } from '#tools/__test__/harness.ts'

afterEach(removeWorkspaces)

// Two links, one each way: `link` inside the tree leads to the outside fixture, and
// `outside/into` leads back to `inside`. Where a write lands is what the Gate measures,
// so a path written through either lands on the far side of it.
const linked = async (root: string): Promise<void> => {
  await onDisk(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      yield* fs.symlink(outside(root), `${root}/link`).pipe(Effect.orDie)
      yield* fs.symlink(`${root}/inside`, `${outside(root)}/into`).pipe(Effect.orDie)
    }),
  )
}

test('write_file inside the Perimeter happens exactly as it did', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'inside/new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(await Bun.file(`${root}/inside/new.txt`).text()).toBe('hello')
})

test('write_file outside the Perimeter does not happen, and says where it would have landed', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: `${root}/../outside/new.txt`, content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(OutsidePerimeter)
  // The tag is the one word of the failure the model can match on.
  expect(Predicate.isTagged(outcome.result, 'OutsidePerimeter')).toBe(true)
  // The refusal is the model's only account of what happened, so it names the path as
  // written, where that really leads, and the tree it may change instead.
  expect(outcome.result).toMatchObject({
    path: `${outside(root)}/new.txt`,
    reason: `write_file will not write ${root}/../outside/new.txt: it would land at ${outside(root)}/new.txt, outside the working tree at ${root} — only files inside that tree can be changed`,
  })
  expect(await Bun.file(`${root}/../outside/new.txt`).exists()).toBe(false)
})

test('edit_file outside the Perimeter leaves the file as it was', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', {
      path: '../outside/secret.txt',
      old_text: 'secret',
      new_text: 'changed',
    }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(OutsidePerimeter)
  expect(outcome.result).toMatchObject({
    reason: expect.stringContaining(
      `edit_file will not write ../outside/secret.txt: it would land at`,
    ),
  })
  expect(await Bun.file(`${root}/../outside/secret.txt`).text()).toBe('secret')
})

test('write_file into the repository’s own metadata is refused', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: '.git/hooks/pre-commit', content: '#!/bin/sh\nrm -rf /' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(OutsidePerimeter)
  expect(outcome.result).toMatchObject({ path: `${root}/.git/hooks/pre-commit` })
  expect(await Bun.file(`${root}/.git/hooks/pre-commit`).exists()).toBe(false)
})

// In a linked worktree `.git` is a file naming the repository, so the entry itself is
// as much the repository's as anything under it.
test('write_file over the metadata entry itself is refused', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: '.git', content: 'gitdir: /elsewhere' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(OutsidePerimeter)
})

test('edit_file inside the repository’s own metadata is refused', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: '.git/HEAD', old_text: 'main', new_text: 'other' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(OutsidePerimeter)
  expect(await Bun.file(`${root}/.git/HEAD`).text()).toBe('ref: refs/heads/main\n')
})

test('write_file through a link inside the tree that leads outside is refused', async () => {
  const root = await workspace()

  await linked(root)

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'link/new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(OutsidePerimeter)
  expect(outcome.result).toMatchObject({ path: `${outside(root)}/new.txt` })
  expect(await Bun.file(`${root}/../outside/new.txt`).exists()).toBe(false)
})

test('edit_file through a link inside the tree that leads outside is refused', async () => {
  const root = await workspace()

  await linked(root)

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', { path: 'link/secret.txt', old_text: 'secret', new_text: 'x' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(OutsidePerimeter)
  expect(await Bun.file(`${root}/../outside/secret.txt`).text()).toBe('secret')
})

// The directories between the link and the file do not exist yet, so the walk to the
// nearest existing ancestor has to pass them on its way to the link.
test('write_file below a link that leads outside is refused however deep the new path', async () => {
  const root = await workspace()

  await linked(root)

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'link/deep/er/new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(OutsidePerimeter)
  expect(await Bun.file(`${root}/../outside/deep/er/new.txt`).exists()).toBe(false)
})

test('write_file through a link outside the tree that leads inside is allowed', async () => {
  const root = await workspace()

  await linked(root)

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: '../outside/into/new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(await Bun.file(`${root}/inside/new.txt`).text()).toBe('hello')
})

test('edit_file through a link outside the tree that leads inside is allowed', async () => {
  const root = await workspace()

  await linked(root)

  const outcome = await call(root, (tools) =>
    tools.handle('edit_file', {
      path: '../outside/into/keep.txt',
      old_text: 'kept',
      new_text: 'edited',
    }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(await Bun.file(`${root}/inside/keep.txt`).text()).toBe('edited')
})

test('write_file to a path whose directories do not exist yet is allowed inside the tree', async () => {
  const root = await workspace()

  const outcome = await call(root, (tools) =>
    tools.handle('write_file', { path: 'inside/deep/er/new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(false)
  expect(await Bun.file(`${root}/inside/deep/er/new.txt`).text()).toBe('hello')
})

test('with no repository above the Workspace, write_file is refused everywhere in it', async () => {
  const directory = await onDisk(temporary)

  const outcome = await call(directory, (tools) =>
    tools.handle('write_file', { path: 'new.txt', content: 'hello' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(OutsidePerimeter)
  expect(outcome.result).toMatchObject({
    reason: `write_file will not write new.txt: git found no working tree at ${directory}, or could not be run there, so there is nothing here the agent may change — nothing can be written until there is`,
  })
  expect(await Bun.file(`${directory}/new.txt`).exists()).toBe(false)
})

test('with no repository above the Workspace, edit_file is refused too', async () => {
  const directory = await onDisk(temporary)

  await Bun.write(`${directory}/edit.txt`, 'one')

  const outcome = await call(directory, (tools) =>
    tools.handle('edit_file', { path: 'edit.txt', old_text: 'one', new_text: 'two' }),
  )

  expect(outcome.isFailure).toBe(true)
  expect(outcome.result).toBeInstanceOf(OutsidePerimeter)
  expect(await Bun.file(`${directory}/edit.txt`).text()).toBe('one')
})

test('with no repository above the Workspace, the agent still reads and searches', async () => {
  const directory = await onDisk(temporary)

  await Bun.write(`${directory}/read.txt`, 'readable')

  const read = await call(directory, (tools) => tools.handle('read_file', { path: 'read.txt' }))

  const found = await call(directory, (tools) => tools.handle('glob', { pattern: '*.txt' }))

  expect(read.result).toBe('     1→readable')
  expect(found.result).toBe('read.txt')
})
