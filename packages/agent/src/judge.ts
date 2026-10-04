import { TypeSafeClient, TypeSafeDecisionModel } from '@effect/ai-typesafe'
import { Clock, Context, Duration, Effect, Layer, Match, Predicate, Schedule, Schema } from 'effect'

import type { Cause } from 'effect'
import { DecisionModel } from 'effect/ai'
import type { AiError, Decision } from 'effect/ai'
import type { HttpClient } from 'effect/http'

// The provider's floating identifier, as it recommends: the Judge is its current model
// rather than a release pinned here and left behind.
// Stryker disable next-line StringLiteral: the identifier only reaches the provider, and
// no test reaches the provider.
const MODEL = 'jev-latest'

const CREDENTIAL = 'TYPESAFE_API_KEY'

/**
 * How long one act may wait on the Judge, the retry included. A Gate sits on the critical
 * path of the act it examines, so past this the act is refused rather than waited for.
 */
export const BUDGET: Duration.Duration = Duration.seconds(5)

/**
 * The Judge has no key to reach its decision model with. Raised as the layer is built,
 * so an agent without a Judge never starts: a Gate that opens because nothing is there
 * to judge is not a Gate (ADR 0001).
 */
export class JudgeCredentialsRequired extends Schema.TaggedError<JudgeCredentialsRequired>()(
  'JudgeCredentialsRequired',
  { reason: Schema.String },
) {
  // This error reaches a terminal rather than the model, and `NodeRuntime.runMain`
  // prints only `cause.message`, so the message names what is missing and how to fix it.
  override get message(): string {
    return `the Judge has no credentials: set ${CREDENTIAL} to a TypeSafe API key (${this.reason})`
  }
}

/** Why the Judge did not answer, which is what says whether asking again could help. */
export const Unanswered = Schema.Literals([
  'TimedOut',
  'RateLimited',
  'CredentialsRejected',
  'Other',
])

export type Unanswered = typeof Unanswered.Type

/**
 * The Judge was asked and did not answer, so the act was refused unjudged. Distinct from
 * a refusal the Judge took part in: this one says to look at the network or the
 * credentials, not at the act, and the same act may be allowed once the Judge answers.
 */
export class JudgeDidNotAnswer extends Schema.TaggedError<JudgeDidNotAnswer>()(
  'JudgeDidNotAnswer',
  { failure: Unanswered, reason: Schema.String },
) {}

const unanswered = (failure: Unanswered, reason: string): JudgeDidNotAnswer =>
  new JudgeDidNotAnswer({ failure, reason })

// One retry, for rate limiting alone, and only when the wait the provider asked for ends
// before the budget does, counted from `started`, before the first attempt. A wait that
// would use up the rest of the budget is not taken: the answer could not arrive in time,
// and being refused as rate limited now tells the model more than timing out later.
const rateLimitedOnce = (started: number): Schedule.Schedule<number, AiError.AiError> =>
  Schedule.recurs(1).pipe(
    Schedule.setInputType<AiError.AiError>(),
    Schedule.while(
      ({ input, now }) =>
        Predicate.isTagged(input.reason, 'RateLimitError') &&
        now - started + Duration.toMillis(input.retryAfter ?? Duration.zero) <
          Duration.toMillis(BUDGET),
    ),
    Schedule.modifyDelay(({ input }) => Effect.succeed(input.retryAfter ?? Duration.zero)),
  )

// Every way the call can fail, in the words the model and the transcript are given.
const didNotAnswer = (error: AiError.AiError | Cause.TimeoutError): JudgeDidNotAnswer =>
  Match.value(error).pipe(
    Match.tag('TimeoutError', () =>
      unanswered(
        'TimedOut',
        `the Judge did not answer within ${Duration.format(BUDGET)}, so the act was refused unjudged; the network may be slow, and asking again may succeed`,
      ),
    ),
    Match.tag('AiError', (failed) =>
      Match.value(failed.reason).pipe(
        Match.tag('RateLimitError', () =>
          unanswered(
            'RateLimited',
            `the Judge is rate limited and gave no answer within ${Duration.format(BUDGET)}, so the act was refused unjudged; wait before asking again`,
          ),
        ),
        Match.tag('AuthenticationError', () =>
          unanswered(
            'CredentialsRejected',
            `the Judge rejected its credentials, so the act was refused unjudged; asking again will not help until ${CREDENTIAL} holds a valid key`,
          ),
        ),
        Match.orElse(() =>
          unanswered(
            'Other',
            `the Judge failed (${failed.message}), so the act was refused unjudged`,
          ),
        ),
      ),
    ),
    Match.exhaustive,
  )

/**
 * The decision model a Gate consults. It answers the fixed questions of a definition
 * with probabilities and nothing more: the Verdict is the Gate's to derive, and every
 * fact with a local answer is in the input, never among the questions (ADR 0001).
 *
 * A service rather than the decision model itself, because the budget and the one
 * retry are the Judge's policy, and every Gate has to meet them the same way.
 */
// Stryker disable StringLiteral: the key only names the service in a context, and nothing
// else in the package claims a name it could collide with.
export class Judge extends Context.Service<
  Judge,
  {
    /**
     * The Judge's answers to `definition` about the facts in `input`: one call under the
     * whole of `BUDGET`, retried once for rate limiting when the wait fits in it. Whatever
     * else goes wrong, the Judge did not answer.
     */
    readonly judge: <
      Input extends Schema.Constraint,
      Decisions extends Record<string, Decision.Any>,
    >(
      definition: Decision.Definition<Input, Decisions>,
      input: Input['Type'],
    ) => Effect.Effect<Decision.Answers<Decisions>, JudgeDidNotAnswer, Input['EncodingServices']>
  }
>()('agent/Judge') {
  // Stryker restore StringLiteral
  /** The Judge over whatever decision model is provided: the tests' scripted one. */
  static readonly layerWithoutModel: Layer.Layer<Judge, never, DecisionModel.DecisionModel> =
    Layer.effect(
      Judge,
      Effect.gen(function* () {
        const model = yield* DecisionModel.DecisionModel

        const judge = <
          Input extends Schema.Constraint,
          Decisions extends Record<string, Decision.Any>,
        >(
          definition: Decision.Definition<Input, Decisions>,
          input: Input['Type'],
        ): Effect.Effect<
          Decision.Answers<Decisions>,
          JudgeDidNotAnswer,
          Input['EncodingServices']
        > =>
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis

            const { answers } = yield* model
              .decide(definition, { input })
              .pipe(
                Effect.retry(rateLimitedOnce(started)),
                Effect.timeout(BUDGET),
                Effect.mapError(didNotAnswer),
              )

            return answers
          }).pipe(
            // Stryker disable next-line StringLiteral: the name only labels the span, which
            // nothing in the package reads.
            Effect.withSpan('Judge.judge'),
          )

        return Judge.of({ judge })
      }),
    )

  /**
   * The Judge the agent runs: TypeSafe's decision model, with the key read from
   * configuration as the layer is built. No key, no layer, and so no agent. Whether the
   * key is any good is only found out at the first act it is asked about, which is then
   * refused with the credentials named, and the session goes on.
   */
  static readonly layer: Layer.Layer<Judge, JudgeCredentialsRequired, HttpClient.HttpClient> =
    Judge.layerWithoutModel.pipe(
      Layer.provide(TypeSafeDecisionModel.model(MODEL)),
      Layer.provide(
        TypeSafeClient.layerConfig().pipe(
          Layer.catchTag('ConfigError', (error) =>
            Layer.effect(
              TypeSafeClient.TypeSafeClient,
              Effect.fail(new JudgeCredentialsRequired({ reason: error.message })),
            ),
          ),
        ),
      ),
    )
}
