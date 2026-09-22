import { Effect, Layer, Ref, Schema, Stream } from 'effect'

import type { FileSystem, Path } from 'effect'
import type { AiError, Chat, LanguageModel, Prompt, Response, Toolkit } from 'effect/unstable/ai'
import { FetchHttpClient } from 'effect/unstable/http'
import type { ChildProcessSpawner } from 'effect/unstable/process'

import { ToolCall } from './activity.ts'
import * as Codex from './codex.ts'
import { toolkitLayer } from './tools/index.ts'

import type { Activity } from './activity.ts'
import type { Handlers, Tools } from './tools/index.ts'

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

// The prompt the conversation starts from, and what the workspace has to say for
// itself, are one concern; `prompt.ts` holds it.
export { chat, InstructionsUnreadable } from './prompt.ts'

export { Workspace } from './workspace.ts'

export type { Activity, Reply, ToolFailure, ToolResult } from './activity.ts'

export type { Handlers, Tools } from './tools/index.ts'

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

// Text leaves as it lands, one fragment per part, so whoever is watching can show the
// answer being written rather than waiting for the turn to end. The fragments a model
// writes before reaching for a tool are the agent thinking aloud, and they go out too.
const reported = (part: Response.StreamPart<Tools, 'opaque'>): Stream.Stream<Activity> => {
  if (part.type === 'text-delta') {
    return Stream.succeed({ id: part.id, text: part.delta, type: 'reply' })
  }

  if (part.type === 'tool-call') {
    return called(part)
  }

  return part.type === 'tool-result' ? Stream.succeed(part) : Stream.empty
}

export const answer = (
  chat: Chat.Chat,
  tools: Toolkit.WithHandler<Tools>,
  question: Prompt.RawInput,
): Stream.Stream<Activity, AiError.AiError, LanguageModel.LanguageModel> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const calledTools = yield* Ref.make(false)

      const turn = chat.streamText({ prompt: question, toolkit: tools }).pipe(
        Stream.tap((part) =>
          part.type === 'tool-call' ? Ref.set(calledTools, true) : Effect.void,
        ),
        Stream.flatMap(reported),
      )

      // A turn that reached for a tool has not answered yet. The empty prompt sends
      // the model back in with the results the chat is already holding. A turn that
      // did not has already said everything it had to say, fragment by fragment.
      const rest = Stream.unwrap(
        Effect.map(
          Ref.get(calledTools),
          (reached): Stream.Stream<Activity, AiError.AiError, LanguageModel.LanguageModel> =>
            reached ? answer(chat, tools, []) : Stream.empty,
        ),
      )

      return Stream.concat(turn, rest)
    }),
  )

export const layer: Layer.Layer<
  LanguageModel.LanguageModel | Handlers,
  Codex.CodexAuthenticationRequired,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Layer.mergeAll(toolkitLayer, Codex.layer.pipe(Layer.provide(FetchHttpClient.layer)))
