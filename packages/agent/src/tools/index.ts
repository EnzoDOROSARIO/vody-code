import { Effect, Layer } from 'effect'

import type { FileSystem, Path } from 'effect'
import type { Tool } from 'effect/unstable/ai'
import type { ChildProcessSpawner } from 'effect/unstable/process'

import * as Bash from './bash.ts'
import * as EditFile from './edit-file.ts'
import { Files } from './files.ts'
import * as Glob from './glob.ts'
import { before, Hooks } from './hooks.ts'
import * as ReadFile from './read-file.ts'
import { toolkit } from './toolkit.ts'
import * as WriteFile from './write-file.ts'

import type { Tools } from './toolkit.ts'

// Each tool owns the errors it raises. They are re-exported here so a caller still
// finds the whole vocabulary in one import.
export { CommandRefused, CommandTimedOut } from './bash.ts'

export { TextNotFound, TextNotUnique } from './edit-file.ts'

export { FileSystemRefused } from './errors.ts'

export { Hooks } from './hooks.ts'

export { FileIsBinary } from './read-file.ts'

export { toolkit } from './toolkit.ts'

export { FileNotRead } from './write-file.ts'

export type { Hook } from './hooks.ts'

export type { Call, Tools } from './toolkit.ts'

export type Handlers = Tool.HandlersFor<Tools>

// The one place a handler context is made, so every tool passes through the seam on
// its way in: a tool is only ever handed over wrapped in whatever hook is at the
// seam for it. `Files` is provided here because the record of what has been read
// only means anything if the three tools that read and write files share one.
export const toolkitLayer: Layer.Layer<
  Handlers,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = toolkit
  .toLayer(
    Effect.gen(function* () {
      const hooks = yield* Hooks

      const bash = yield* Bash.handlers
      const editFile = yield* EditFile.handlers
      const glob = yield* Glob.handlers
      const readFile = yield* ReadFile.handlers
      const writeFile = yield* WriteFile.handlers

      return toolkit.of({
        bash: before(hooks, 'bash', bash.bash),
        edit_file: before(hooks, 'edit_file', editFile.edit_file),
        glob: before(hooks, 'glob', glob.glob),
        read_file: before(hooks, 'read_file', readFile.read_file),
        write_file: before(hooks, 'write_file', writeFile.write_file),
      })
    }),
  )
  .pipe(Layer.provide(Files.layer))
