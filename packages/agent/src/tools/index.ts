import { Layer } from 'effect'

import { Toolkit } from 'effect/unstable/ai'

import type { FileSystem, Path } from 'effect'
import type { Tool } from 'effect/unstable/ai'
import type { ChildProcessSpawner } from 'effect/unstable/process'

import * as Bash from './bash.ts'
import * as EditFile from './edit-file.ts'
import { Files } from './files.ts'
import * as Glob from './glob.ts'
import * as ReadFile from './read-file.ts'
import * as WriteFile from './write-file.ts'

// Each tool owns the errors it raises. They are re-exported here so a caller still
// finds the whole vocabulary in one import.
export { CommandRefused, CommandTimedOut } from './bash.ts'

export { TextNotFound, TextNotUnique } from './edit-file.ts'

export { FileSystemRefused } from './errors.ts'

export { FileIsBinary } from './read-file.ts'

export { FileNotRead } from './write-file.ts'

export const toolkit = Toolkit.merge(
  Bash.toolkit,
  EditFile.toolkit,
  Glob.toolkit,
  ReadFile.toolkit,
  WriteFile.toolkit,
)

export type Handlers = Tool.HandlersFor<(typeof toolkit)['tools']>

// One handler service per tool, so the tools are layers that merge. `Files` is
// provided here because the record of what has been read only means anything if
// the three tools that read and write files share one.
export const toolkitLayer: Layer.Layer<
  Handlers,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Layer.mergeAll(Bash.layer, EditFile.layer, Glob.layer, ReadFile.layer, WriteFile.layer).pipe(
  Layer.provide(Files.layer),
)
