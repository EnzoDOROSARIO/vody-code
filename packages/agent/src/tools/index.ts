import { Effect, Layer } from 'effect'

import type { FileSystem, Path } from 'effect'
import type { Tool } from 'effect/ai'
import type { ChildProcessSpawner } from 'effect/process'

import * as Bash from './bash.ts'
import * as EditFile from './edit-file.ts'
import { Files } from './files.ts'
import * as Glob from './glob.ts'
import { before, Hooks } from './hooks.ts'
import * as LoadSkill from './load-skill.ts'
import * as ReadFile from './read-file.ts'
import { toolkit } from './toolkit.ts'
import * as WriteFile from './write-file.ts'
import * as WritePlan from './write-plan.ts'

import type { Tools } from './toolkit.ts'
import type { Workspace } from '#workspace.ts'

// Each tool owns the errors it raises. They are re-exported here so a caller still
// finds the whole vocabulary in one import.
export { CommandRefused, CommandTimedOut } from './bash.ts'

export { TextNotFound, TextNotUnique } from './edit-file.ts'

export { FileSystemRefused } from './errors.ts'

export { Hooks } from './hooks.ts'

export { SkillNotFound } from './load-skill.ts'

export { FileIsBinary } from './read-file.ts'

// Raised by the Gates in front of bash, write_file and edit_file rather than by any tool,
// but they are answers those tools can give, so they belong in the same vocabulary.
export { JudgeDidNotAnswer } from '#judge.ts'

export { ActRefused } from '#verdict.ts'

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
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Workspace
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
        // The Plan acts on nothing on the machine, so no Gate stands in front of it; it
        // still passes through the seam, where nothing is at it.
        write_plan: before(hooks, 'write_plan', WritePlan.handler),
        // A load serves the Catalog's startup copy and touches nothing, so no Gate
        // stands in front of it either; it passes through the same empty seam.
        load_skill: before(hooks, 'load_skill', LoadSkill.handler),
      })
    }),
  )
  .pipe(Layer.provide(Files.layer))
