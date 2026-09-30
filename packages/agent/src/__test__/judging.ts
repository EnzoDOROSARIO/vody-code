import { Effect, Layer, Option, Queue, Ref } from 'effect'

import type { Duration, Schema } from 'effect'
import { AiError, DecisionModel } from 'effect/unstable/ai'

import { Judge } from '#judge.ts'

/** How the scripted decision model answers one question put to it. */
export type Reply = (
  options: DecisionModel.ProviderOptions,
) => Effect.Effect<DecisionModel.ProviderResponse, AiError.AiError>

const NO_USAGE = { inputTokens: undefined, outputTokens: undefined }

/**
 * Answers every question in the definition: with the probability named for it in
 * `probabilities`, and 0 for any question left out, which for a danger is the safe side.
 */
export const answering =
  (probabilities: ReadonlyMap<string, number>): Reply =>
  ({ decisions }) =>
    Effect.succeed({
      answers: Object.fromEntries(
        Object.keys(decisions).map((key) => [
          key,
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- the provider answer is a plain interface with no constructor of its own
          { _tag: 'Probability', probability: probabilities.get(key) ?? 0 },
        ]),
      ),
      usage: NO_USAGE,
    })

// A failure as the TypeSafe client raises it, which is where a real one comes from.
const failing =
  (reason: AiError.AiErrorReason): Reply =>
  () =>
    Effect.fail(AiError.make({ module: 'TypeSafeClient', method: 'systemOne', reason }))

/** A 429, with the delay the provider asked for, or none. */
export const rateLimited = (retryAfter: Option.Option<Duration.Duration>): Reply =>
  failing(
    new AiError.RateLimitError({ retryAfter: Option.getOrUndefined(retryAfter), metadata: {} }),
  )

/** A 401: the key was sent and refused. */
export const rejected: Reply = failing(
  new AiError.AuthenticationError({ kind: 'InvalidKey', metadata: {} }),
)

/** A 500, which the provider calls retryable and the Judge does not retry. */
export const broken: Reply = failing(
  new AiError.InternalProviderError({ description: 'the provider fell over', metadata: {} }),
)

/** No answer, ever: the budget is all that ends the wait. */
export const hanging: Reply = () => Effect.never

/** `reply`, once `wait` has gone by on the clock the Judge runs on. */
export const after =
  (wait: Duration.Input, reply: Reply): Reply =>
  (options) =>
    Effect.sleep(wait).pipe(Effect.andThen(reply(options)))

/**
 * The Judge the tests stand up: the real one, budget and retry and all, over a decision
 * model whose replies are scripted. The first question put to it gets the first reply,
 * the next the next, and the last reply stands for every question after it. Each
 * question's facts go into `asked`, as the provider would receive them, so a test can
 * see what the Judge was told, and wait for it to be asked.
 */
export const judging = (
  replies: readonly [Reply, ...Array<Reply>],
  asked?: Queue.Queue<Schema.Json>,
): Layer.Layer<Judge> =>
  Judge.layerWithoutModel.pipe(
    Layer.provide(
      Layer.effect(
        DecisionModel.DecisionModel,
        Effect.gen(function* () {
          const count = yield* Ref.make(0)

          return yield* DecisionModel.make({
            decide: (options) =>
              Effect.gen(function* () {
                const turn = yield* Ref.getAndUpdate(count, (n) => n + 1)

                if (asked !== undefined) {
                  yield* Queue.offer(asked, options.state)
                }

                const reply = replies[Math.min(turn, replies.length - 1)] ?? replies[0]

                return yield* reply(options)
              }),
          })
        }),
      ),
    ),
  )

/** The reply that finds the act asked about requested and harmless. */
export const allows: Reply = answering(new Map([['serves_request', 1]]))

/** A Judge that finds every act it is asked about requested and harmless. */
export const allowing: Layer.Layer<Judge> = judging([allows])
