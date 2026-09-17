import { AnthropicClient, AnthropicLanguageModel } from '@effect/ai-anthropic'
import { Config, Console, Effect, Layer, Schema, Terminal } from 'effect'
import { Chat, Prompt, Tool, Toolkit } from 'effect/unstable/ai'
import type { AiError, LanguageModel } from 'effect/unstable/ai'
import { FetchHttpClient } from 'effect/unstable/http'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

const systemPrompt = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`

/** One tool is enough: everything else is something the model can shell out to. */
const bash = Tool.make('bash', {
  description: 'Run a shell command.',
  parameters: Schema.Struct({ command: Schema.String }),
  success: Schema.String,
})

/** The agent's toolkit: one tool, as in the reference loop. */
export const toolkit = Toolkit.make(bash)

/**
 * Runs the agent's commands, echoing each one and the head of its output so
 * you can watch the loop work. stdout and stderr are interleaved, and a
 * non-zero exit status is ordinary output rather than a failure.
 */
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
 * The agent loop: send the conversation, run whatever tools the model asked
 * for, send the results back, and go around again. Returns on the first turn
 * where the model calls no tool, which is the turn that answers the question.
 *
 * `chat` accumulates the conversation, so asking the same chat a second
 * question continues it rather than starting over.
 */
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
      const response = yield* chat.generateText({ prompt, toolkit: tools })

      if (response.toolCalls.length === 0) {
        return response.text
      }

      prompt = []
    }
  })

/**
 * The REPL around {@link answer}: read a question, print the answer, ask again.
 * Completes when the person quits the terminal input.
 *
 * Run it from an entrypoint with `BunRuntime.runMain`.
 */
export const main: Effect.Effect<
  void,
  never,
  LanguageModel.LanguageModel | Terminal.Terminal | Tool.Handler<'bash'>
> = Effect.gen(function* () {
  const terminal = yield* Terminal.Terminal
  const tools = yield* toolkit
  const chat = yield* Chat.fromPrompt(Prompt.empty.pipe(Prompt.setSystem(systemPrompt)))

  while (true) {
    yield* Console.log('')

    const question = yield* terminal.readLine
    const reply = yield* answer(chat, tools, question)

    yield* Console.log(reply)
  }
}).pipe(
  Effect.catchTag('QuitError', () => Effect.void),
  Effect.orDie,
)

/**
 * Everything `main` needs apart from the platform: an Anthropic model reached
 * over `fetch`, plus the bash handler. Reads `ANTHROPIC_API_KEY` and,
 * optionally, `MODEL_ID` from the environment.
 *
 * Which platform runs the shell commands is left to the entrypoint.
 */
export const layer: Layer.Layer<
  LanguageModel.LanguageModel | Tool.Handler<'bash'>,
  Config.ConfigError,
  ChildProcessSpawner.ChildProcessSpawner
> = Layer.mergeAll(
  toolkitLayer,
  Layer.unwrap(
    Config.String('MODEL_ID').pipe(
      Config.withDefault('claude-opus-5'),
      Effect.map((model) => AnthropicLanguageModel.layer({ model })),
    ),
  ).pipe(
    Layer.provide(
      AnthropicClient.layerConfig({ apiKey: Config.Redacted('ANTHROPIC_API_KEY') }).pipe(
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
  ),
)
