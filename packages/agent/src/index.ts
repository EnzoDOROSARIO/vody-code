import { Console, Effect, Layer, Schema, Stream } from 'effect'

import type { FileSystem } from 'effect'
import { Chat, Prompt, Tool, Toolkit } from 'effect/unstable/ai'
import type { AiError, LanguageModel } from 'effect/unstable/ai'
import { FetchHttpClient } from 'effect/unstable/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import * as Codex from './codex.ts'

const systemPrompt = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`

const bash = Tool.make('bash', {
  description: 'Run a shell command.',
  parameters: Schema.Struct({ command: Schema.String }),
  success: Schema.String,
})

export const toolkit = Toolkit.make(bash)

export const toolkitLayer: Layer.Layer<
  Tool.Handler<'bash'>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> = toolkit.toLayer(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    return toolkit.of({
      bash: Effect.fn('bash')(function* ({ command }) {
        yield* Console.log(`$ ${command}`)

        const output = yield* spawner
          .string(ChildProcess.make('sh', ['-c', command]), { includeStderr: true })
          .pipe(Effect.orDie)

        yield* Console.log(output.slice(0, 200))

        return output
      }),
    })
  }),
)

/**
 * One turn of the loop, streamed.
 *
 * `streamText` rather than `generateText` because the ChatGPT Codex backend
 * only serves streaming responses — it rejects a non-streamed request outright.
 * The two differ in delivery, not in meaning: the same parts arrive either way,
 * and `Chat` still runs the tool handlers, so the decision below is unchanged.
 */
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
    // The first turn carries the question; later turns add nothing, since the
    // chat already holds the tool results the model needs to read.
    let prompt: Prompt.RawInput = question

    while (true) {
      const response = yield* turn(chat, tools, prompt)

      if (!response.calledTools) {
        return response.text
      }

      prompt = []
    }
  })

/** A fresh conversation, carrying the system prompt. */
export const chat: Effect.Effect<Chat.Chat> = Chat.fromPrompt(
  Prompt.empty.pipe(Prompt.setSystem(systemPrompt)),
)

export const layer: Layer.Layer<
  LanguageModel.LanguageModel | Tool.Handler<'bash'>,
  Codex.CodexAuthenticationRequired,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> = Layer.mergeAll(toolkitLayer, Codex.layer.pipe(Layer.provide(FetchHttpClient.layer)))
