import { Effect, Layer, Ref, Schema, Stream } from 'effect'

import type { FileSystem, Path } from 'effect'
import { Chat, Prompt } from 'effect/unstable/ai'
import type { AiError, LanguageModel, Response, Toolkit } from 'effect/unstable/ai'
import { FetchHttpClient } from 'effect/unstable/http'
import type { ChildProcessSpawner } from 'effect/unstable/process'

import { ToolCall } from './activity.ts'
import * as Codex from './codex.ts'
import { toolkitLayer } from './tools/index.ts'
import { Workspace } from './workspace.ts'

import type { Activity, Tools } from './activity.ts'
import type { Handlers } from './tools/index.ts'

export { ToolCall } from './activity.ts'

// The TUI now accounts for a failed tool call, so the errors a tool can return are
// part of what this package hands out, not an internal of the toolkit.
export {
  CommandRefused,
  CommandTimedOut,
  FileIsBinary,
  FileNotRead,
  FileSystemRefused,
  TextNotFound,
  TextNotUnique,
} from './tools/index.ts'

export { toolkit } from './tools/index.ts'

export { Workspace } from './workspace.ts'

export type { Activity, Reply, ToolFailure, ToolResult, Tools } from './activity.ts'

export type { Handlers } from './tools/index.ts'

const systemPrompt = (workspace: string): string =>
  `You are a coding agent at ${workspace}. Use your tools to solve tasks. Act, don't explain.`

type Progress = {
  readonly calledTools: boolean
  readonly text: string
}

// The arguments are checked against the same schema the tool itself decodes with, so
// a call that fails here is one the tool is about to refuse. Staying quiet costs
// nothing: the refusal arrives as the very next result, and that result is reported.
const called = (part: Response.ToolCallParts<Tools, 'opaque'>): Stream.Stream<Activity> =>
  Stream.unwrap(
    Schema.decodeUnknownEffect(ToolCall)(part).pipe(
      Effect.map((call): Stream.Stream<Activity> => Stream.succeed(call)),
      Effect.orElseSucceed(() => Stream.empty),
    ),
  )

const reported = (part: Response.StreamPart<Tools, 'opaque'>): Stream.Stream<Activity> => {
  if (part.type === 'tool-call') {
    return called(part)
  }

  return part.type === 'tool-result' ? Stream.succeed(part) : Stream.empty
}

const record = (
  progress: Ref.Ref<Progress>,
  part: Response.StreamPart<Tools, 'opaque'>,
): Effect.Effect<void> => {
  if (part.type === 'text-delta') {
    return Ref.update(progress, (seen) => ({ ...seen, text: seen.text + part.delta }))
  }

  if (part.type === 'tool-call') {
    return Ref.update(progress, (seen) => ({ ...seen, calledTools: true }))
  }

  return Effect.void
}

export const answer = (
  chat: Chat.Chat,
  tools: Toolkit.WithHandler<Tools>,
  question: Prompt.RawInput,
): Stream.Stream<Activity, AiError.AiError, LanguageModel.LanguageModel> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const progress = yield* Ref.make<Progress>({ calledTools: false, text: '' })

      const turn = chat.streamText({ prompt: question, toolkit: tools }).pipe(
        Stream.tap((part) => record(progress, part)),
        Stream.flatMap(reported),
      )

      // A turn that reached for a tool has not answered yet. The empty prompt sends
      // the model back in with the results the chat is already holding.
      const rest = Stream.unwrap(
        Effect.map(
          Ref.get(progress),
          (seen): Stream.Stream<Activity, AiError.AiError, LanguageModel.LanguageModel> =>
            seen.calledTools
              ? answer(chat, tools, [])
              : Stream.succeed({ type: 'reply', text: seen.text }),
        ),
      )

      return Stream.concat(turn, rest)
    }),
  )

export const chat: Effect.Effect<Chat.Chat> = Effect.flatMap(Workspace, (directory) =>
  Chat.fromPrompt(Prompt.empty.pipe(Prompt.setSystem(systemPrompt(directory)))),
)

export const layer: Layer.Layer<
  LanguageModel.LanguageModel | Handlers,
  Codex.CodexAuthenticationRequired,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Layer.mergeAll(toolkitLayer, Codex.layer.pipe(Layer.provide(FetchHttpClient.layer)))
