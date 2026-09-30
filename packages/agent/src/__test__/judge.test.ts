import { BunServices } from '@effect/platform-bun'
import { afterEach, expect, test } from 'bun:test'
import {
  Clock,
  ConfigProvider,
  Duration,
  Effect,
  Encoding,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
} from 'effect'

import type { Cause, Schema } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'

import { TestClock } from 'effect/testing'

import { after, allows, broken, hanging, judging, rateLimited, rejected } from './judging.ts'
import { judged, onDisk, outside, removeWorkspaces, temporary, workspace } from './testing.ts'
import { layer } from '#index.ts'
import { BUDGET, Judge, JudgeCredentialsRequired } from '#judge.ts'
import { ActRefused, JudgeDidNotAnswer } from '#tools/index.ts'
import { outcome, run } from '#tools/__test__/harness.ts'

import type { Reply } from './judging.ts'
import type { Tools } from '#tools/index.ts'
import type { Toolkit } from 'effect/unstable/ai'

afterEach(removeWorkspaces)

const env = (variables: Readonly<Record<string, string>>): Layer.Layer<never> =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: variables }))

// Whether `built` builds, with nothing but `variables` to configure it from.
const building = <Built, E>(
  built: Layer.Layer<Built, E>,
  variables: Readonly<Record<string, string>>,
): Promise<Exit.Exit<void, E>> =>
  Effect.runPromiseExit(
    Effect.scoped(Effect.asVoid(Layer.build(built.pipe(Layer.provide(env(variables)))))),
  )

const MISSING = 'the Judge has no credentials: set TYPESAFE_API_KEY to a TypeSafe API key'

test('the Judge does not build without its key, and says which key is missing', async () => {
  const exit = await building(Judge.layer.pipe(Layer.provide(FetchHttpClient.layer)), {})

  expect(Exit.isFailure(exit)).toBe(true)

  const error = Exit.findErrorOption(exit)

  expect(Option.getOrUndefined(error)).toBeInstanceOf(JudgeCredentialsRequired)
  // What configuration said is kept beside the fix, and it names the key as well.
  expect(Option.getOrUndefined(error)).toMatchObject({
    reason: expect.stringContaining('TYPESAFE_API_KEY'),
  })
  expect(Option.map(error, (failed) => failed.message.startsWith(`${MISSING} (`))).toEqual(
    Option.some(true),
  )
})

// The tag is the whole of how a caller tells this failure from any other: `catchTag`
// matches the runtime `_tag` and nothing else, so a caller that wants to ask for the key
// rather than exit has only the name the error is exported under to catch it by.
test('the missing key answers to the tag its type promises', async () => {
  const recovered = await Effect.runPromise(
    Effect.scoped(Layer.build(Judge.layer.pipe(Layer.provide(FetchHttpClient.layer)))).pipe(
      Effect.as('built'),
      Effect.catchTag('JudgeCredentialsRequired', () => Effect.succeed('asked for the key')),
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
      Effect.provide(env({})),
    ),
  )

  expect(recovered).toBe('asked for the key')
})

// A client that dies on any request, so a layer built over it that sent one would not
// build at all.
const unreachable: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die('the network was reached')),
)

// Building it asks nothing of the provider: the key is only tried at the first act.
test('the Judge builds with a key, without reaching the network', async () => {
  const exit = await building(Judge.layer.pipe(Layer.provide(unreachable)), {
    TYPESAFE_API_KEY: 'never-checked',
  })

  expect(Exit.isSuccess(exit)).toBe(true)
})

// A Codex sign-in that is good for another hour, so the only thing the agent could be
// missing is the Judge's key.
const signedIn = async (): Promise<string> => {
  const home = await onDisk(temporary)

  const claims = {
    exp: Math.floor(Effect.runSync(Clock.currentTimeMillis) / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: 'fake-account-id' },
  }

  const token = [
    Encoding.encodeBase64Url('{"alg":"none"}'),
    Encoding.encodeBase64Url(JSON.stringify(claims)),
    '',
  ].join('.')

  await Bun.write(`${home}/auth.json`, JSON.stringify({ tokens: { access_token: token } }))

  return home
}

const agent = layer.pipe(Layer.provideMerge(BunServices.layer))

test('the agent does not start without the Judge’s key, even signed in to Codex', async () => {
  const exit = await building(agent, { CODEX_HOME: await signedIn() })

  expect(Option.getOrUndefined(Exit.findErrorOption(exit))).toBeInstanceOf(JudgeCredentialsRequired)
})

test('the agent starts with the Judge’s key and a Codex sign-in', async () => {
  const exit = await building(agent, {
    CODEX_HOME: await signedIn(),
    TYPESAFE_API_KEY: 'never-checked',
  })

  expect(Exit.isSuccess(exit)).toBe(true)
})

const writing = (tools: Toolkit.WithHandler<Tools>) =>
  tools.handle('write_file', { path: '../outside/new.txt', content: 'hello' })

type Asked = Queue.Queue<Schema.Json>

// Waiting on virtual time can only end when the clock is moved, so a wait that never
// ends is a Gate that stopped keeping to its budget. Each wait is bounded on the real
// clock instead, so such a Gate fails its test at once rather than hanging it.
const promptly = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | Cause.TimeoutError> =>
  effect.pipe(Effect.timeout(Duration.seconds(2)), TestClock.withLive)

// The clock starts well away from zero, so time counted from the start of a question
// and time counted from the epoch come out different.
const START = Duration.toMillis(Duration.days(1))

// One write outside, on virtual time, with the Judge replying as `replies` do. `move`
// runs beside the write once it has started, and is how a test waits for the Judge to
// be asked and moves the clock, with `settled` to say whether the write has finished
// yet; what it saw on the way comes back beside the outcome, and so does how many
// questions were put that no wait took, counted once the write is over.
const timed = <A>(
  root: string,
  replies: readonly [Reply, ...Array<Reply>],
  move: (asked: Asked, settled: Effect.Effect<boolean>) => Effect.Effect<A, Cause.TimeoutError>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked = yield* Queue.unbounded<Schema.Json>()

      const program = Effect.gen(function* () {
        yield* TestClock.setTime(START)

        const fiber = yield* Effect.forkChild(outcome(writing))

        const seen = yield* move(
          asked,
          Effect.sync(() => fiber.pollUnsafe() !== undefined),
        )

        const result = yield* promptly(Fiber.join(fiber))

        return { result, seen, unseen: yield* Queue.size(asked) }
      })

      return yield* program.pipe(
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
        Effect.provide(Layer.mergeAll(judged(root, judging(replies, asked)), TestClock.layer())),
      )
    }),
  )

const askedOnce = (asked: Asked): Effect.Effect<void, Cause.TimeoutError> =>
  promptly(Effect.asVoid(Queue.take(asked)))

test('a Judge that does not answer within the budget refuses the act, unjudged', async () => {
  const root = await workspace()

  const { result, seen } = await timed(root, [hanging], (asked, settled) =>
    Effect.gen(function* () {
      yield* askedOnce(asked)
      yield* TestClock.adjust(Duration.toMillis(BUDGET) - 1)

      const early = yield* settled

      yield* TestClock.adjust(Duration.millis(1))

      return early
    }),
  )

  // Still waiting a millisecond before the budget was spent.
  expect(seen).toBe(false)
  expect(result.isFailure).toBe(true)
  expect(result.result).toBeInstanceOf(JudgeDidNotAnswer)
  expect(result.result).not.toBeInstanceOf(ActRefused)
  // The tag is the one word of the failure the model can match on.
  expect(Predicate.isTagged(result.encodedResult, 'JudgeDidNotAnswer')).toBe(true)
  expect(result.result).toMatchObject({
    failure: 'TimedOut',
    reason:
      'the Judge did not answer within 5s, so the act was refused unjudged; the network may be slow, and asking again may succeed',
  })
  expect(await Bun.file(`${outside(root)}/new.txt`).exists()).toBe(false)
})

// The second question is only put once the delay the provider asked for has gone by,
// and not a moment before.
test('a rate-limited Judge is asked again once the delay it asked for is over', async () => {
  const root = await workspace()

  const { result, seen } = await timed(
    root,
    [rateLimited(Option.some(Duration.seconds(1))), allows],
    (asked) =>
      Effect.gen(function* () {
        yield* askedOnce(asked)
        yield* TestClock.adjust(Duration.millis(999))

        const early = yield* Queue.size(asked)

        yield* TestClock.adjust(Duration.millis(1))

        return early
      }),
  )

  // Nothing had been asked a millisecond before the delay was over.
  expect(seen).toBe(0)
  expect(result.isFailure).toBe(false)
  expect(await Bun.file(`${outside(root)}/new.txt`).text()).toBe('hello')
})

test('a Judge rate limited twice refuses the act, unjudged', async () => {
  const root = await workspace()

  // Asked a second time, and refused all the same.
  const { result, seen, unseen } = await timed(root, [rateLimited(Option.none())], (asked) =>
    askedOnce(asked).pipe(Effect.andThen(askedOnce(asked)), Effect.andThen(Queue.size(asked))),
  )

  // Retried once and no more: nothing was asked a third time, then or later.
  expect(seen).toBe(0)
  expect(unseen).toBe(0)
  expect(result.result).toBeInstanceOf(JudgeDidNotAnswer)
  expect(result.result).toMatchObject({
    failure: 'RateLimited',
    reason:
      'the Judge is rate limited and gave no answer within 5s, so the act was refused unjudged; wait before asking again',
  })
  expect(await Bun.file(`${outside(root)}/new.txt`).exists()).toBe(false)
})

// The budget is the whole act's, not each attempt's: a retry that hangs has only what
// the first attempt and the wait before it left over, and is cut off when that runs out.
test('the budget covers the retry, so a retry that hangs times out with the first attempt counted', async () => {
  const root = await workspace()

  const { result } = await timed(
    root,
    [rateLimited(Option.some(Duration.seconds(1))), hanging],
    (asked) =>
      Effect.gen(function* () {
        yield* askedOnce(asked)
        yield* TestClock.adjust(Duration.seconds(1))
        yield* askedOnce(asked)
        yield* TestClock.adjust(Duration.seconds(4))
      }),
  )

  expect(result.result).toBeInstanceOf(JudgeDidNotAnswer)
  expect(result.result).toMatchObject({ failure: 'TimedOut' })
  expect(await Bun.file(`${outside(root)}/new.txt`).exists()).toBe(false)
})

// Each of these waits would end no sooner than the budget does, so the answer could
// not arrive in time: the Judge is not asked again, and the clock moving past the
// budget finds the act already refused as rate limited rather than timed out.
const tooLong: ReadonlyArray<readonly [string, Reply]> = [
  ['far beyond the budget', rateLimited(Option.some(Duration.hours(1)))],
  ['exactly the budget', rateLimited(Option.some(BUDGET))],
  [
    'what is left of the budget after the first answer took its time',
    after(Duration.seconds(3), rateLimited(Option.some(Duration.seconds(3)))),
  ],
]

test.each(tooLong)('a delay of %s refuses without asking again', async (_, first) => {
  const root = await workspace()

  const { result, seen } = await timed(root, [first, allows], (asked) =>
    askedOnce(asked).pipe(
      Effect.andThen(TestClock.adjust(BUDGET)),
      Effect.andThen(Queue.size(asked)),
    ),
  )

  // Asked once, and not again.
  expect(seen).toBe(0)
  expect(result.result).toBeInstanceOf(JudgeDidNotAnswer)
  expect(result.result).toMatchObject({ failure: 'RateLimited' })
  expect(await Bun.file(`${outside(root)}/new.txt`).exists()).toBe(false)
})

// The provider counts a 500 as retryable. The Judge does not: only a rate limit says
// when asking again will help.
test('a Judge that fails any other way refuses the act at once, without asking again', async () => {
  const root = await workspace()

  const asked = Effect.runSync(Queue.unbounded<Schema.Json>())

  const result = await run(judged(root, judging([broken, allows], asked)), writing)

  expect(result.result).toBeInstanceOf(JudgeDidNotAnswer)
  expect(result.result).toMatchObject({
    failure: 'Other',
    reason: expect.stringMatching(/^the Judge failed \(.+\), so the act was refused unjudged$/),
  })
  expect(Effect.runSync(Queue.size(asked))).toBe(1)
})

// The session goes on: the same Judge is asked about the next act, and answers it.
test('rejected credentials refuse the act and leave the session running', async () => {
  const root = await workspace()

  const [first, second] = await Effect.runPromise(
    Effect.all([outcome(writing), outcome(writing)]).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
      Effect.provide(judged(root, judging([rejected, allows]))),
    ),
  )

  expect(first.result).toBeInstanceOf(JudgeDidNotAnswer)
  expect(first.result).toMatchObject({
    failure: 'CredentialsRejected',
    reason:
      'the Judge rejected its credentials, so the act was refused unjudged; asking again will not help until TYPESAFE_API_KEY holds a valid key',
  })
  expect(second.isFailure).toBe(false)
  expect(await Bun.file(`${outside(root)}/new.txt`).text()).toBe('hello')
})
