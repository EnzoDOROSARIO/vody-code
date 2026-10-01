import { Layer } from 'effect'

import type { FileSystem, Path } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import type { ChildProcessSpawner } from 'effect/unstable/process'

import * as Codex from './codex.ts'
import * as Gates from './gates.ts'
import { Judge } from './judge.ts'
import { Session } from './session.ts'
import { toolkitLayer } from './tools/index.ts'

import type { JudgeCredentialsRequired } from './judge.ts'
import type { InstructionsUnreadable } from './prompt.ts'
import type { Handlers } from './tools/index.ts'

export { Session } from './session.ts'

// The TUI now accounts for a failed tool call, so the errors a tool can return are
// part of what this package hands out, not an internal of the toolkit.
export {
  ActRefused,
  CommandRefused,
  CommandTimedOut,
  FileIsBinary,
  FileNotRead,
  FileSystemRefused,
  JudgeDidNotAnswer,
  TextNotFound,
  TextNotUnique,
} from './tools/index.ts'

export { InstructionsUnreadable } from './prompt.ts'

export { Workspace } from './workspace.ts'

export { JudgeCredentialsRequired } from './judge.ts'

export { answer } from './turn.ts'

export { ToolCall } from './activity.ts'

export type { Activity, Breakdown, Impasse, Reply, ToolFailure, ToolResult } from './activity.ts'

export type { Handlers, Tools } from './tools/index.ts'

/**
 * The handlers the agent runs, with both Gates in front of them. The Gates go in
 * under the toolkit, where the hooks are read, so no ungated set is ever built; and
 * this is the one gated set, which the package's tests build on as well, so the agent
 * cannot stop running a Gate without that Gate's own tests saying so. The Judge the
 * Gates consult is left open, for `layer` to give it the real one and the tests a
 * scripted one.
 */
export const handlers: Layer.Layer<
  Handlers,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Judge | Path.Path
> = toolkitLayer.pipe(Layer.provide(Gates.layer))

/**
 * Everything the agent needs from this package, composed as the session the screen
 * mounts: one service that owns a Turn end to end. Both models need their credentials
 * to build, and the conversation needs the workspace's instructions read, so a missing
 * sign-in, a missing Judge key, or unreadable instructions stop the agent before it
 * starts.
 */
export const layer: Layer.Layer<
  Session,
  Codex.CodexAuthenticationRequired | InstructionsUnreadable | JudgeCredentialsRequired,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Session.layer.pipe(
  Layer.provide(handlers.pipe(Layer.provide(Judge.layer))),
  Layer.provide(Codex.layer),
  Layer.provide(FetchHttpClient.layer),
)
