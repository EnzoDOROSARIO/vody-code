import { Effect, Layer, Stream } from 'effect'

import type { FileSystem, Path } from 'effect'
import { Chat, Prompt } from 'effect/unstable/ai'
import type { AiError, LanguageModel, Toolkit } from 'effect/unstable/ai'
import { FetchHttpClient } from 'effect/unstable/http'
import type { ChildProcessSpawner } from 'effect/unstable/process'

import * as Codex from './codex.ts'
import { toolkitLayer } from './tools/index.ts'
import { Workspace } from './workspace.ts'

import type { Handlers, toolkit } from './tools/index.ts'

export { toolkit } from './tools/index.ts'

export { Workspace } from './workspace.ts'

export type { Handlers } from './tools/index.ts'

const systemPrompt = (workspace: string): string =>
  `You are a coding agent at ${workspace}. Use your tools to solve tasks. Act, don't explain.`

const turn = (
  chat: Chat.Chat,
  tools: Toolkit.WithHandler<(typeof toolkit)['tools']>,
  prompt: Prompt.RawInput,
): Effect.Effect<
  { readonly calledTools: boolean; readonly text: string },
  AiError.AiError,
  LanguageModel.LanguageModel
> =>
  Effect.gen(function* () {
    const parts = yield* Stream.runCollect(chat.streamText({ prompt, toolkit: tools }))

    let calledTools = false
    let text = ''

    for (const part of parts) {
      if (part.type === 'text-delta') {
        text += part.delta
      } else if (part.type === 'tool-call') {
        calledTools = true
      }
    }

    return { calledTools, text }
  })

export const answer = (
  chat: Chat.Chat,
  tools: Toolkit.WithHandler<(typeof toolkit)['tools']>,
  question: string,
): Effect.Effect<string, AiError.AiError, LanguageModel.LanguageModel> =>
  Effect.gen(function* () {
    let prompt: Prompt.RawInput = question

    while (true) {
      const response = yield* turn(chat, tools, prompt)

      if (!response.calledTools) {
        return response.text
      }

      prompt = []
    }
  })

export const chat: Effect.Effect<Chat.Chat> = Effect.flatMap(Workspace, (directory) =>
  Chat.fromPrompt(Prompt.empty.pipe(Prompt.setSystem(systemPrompt(directory)))),
)

export const layer: Layer.Layer<
  LanguageModel.LanguageModel | Handlers,
  Codex.CodexAuthenticationRequired,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Layer.mergeAll(toolkitLayer, Codex.layer.pipe(Layer.provide(FetchHttpClient.layer)))
