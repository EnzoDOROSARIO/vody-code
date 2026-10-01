import { expect, it } from '@effect/vitest'
import { Context, Effect, Exit, Layer, Predicate, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import { LanguageModel } from 'effect/unstable/ai'

import { authenticate, layer, withEncryptedReasoning } from '#codex.ts'
import { CodexAuthenticationRequired, CodexCredentials } from '#credentials.ts'

import { rendered } from './testing.ts'
import type { Credential } from '#credentials.ts'

const Body = Schema.Struct({
  include: Schema.optionalKey(Schema.Array(Schema.String)),
  model: Schema.optionalKey(Schema.String),
  reasoning: Schema.optionalKey(Schema.Struct({ effort: Schema.optionalKey(Schema.String) })),
  store: Schema.optionalKey(Schema.Boolean),
})

const decodeBody = Schema.decodeEffect(Schema.fromJsonString(Body))

const sent = (request: HttpClientRequest.HttpClientRequest): typeof Body.Type => {
  const body = request.body

  return Predicate.isTagged(body, 'Uint8Array')
    ? Effect.runSync(decodeBody(body.text ?? new TextDecoder().decode(body.body)))
    : {}
}

// Absolute, because a request that is executed rather than only inspected has no
// base URL to be relative to.
const responses = (body: typeof Body.Type): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.bodyJsonUnsafe(
    HttpClientRequest.post('https://chatgpt.com/backend-api/codex/responses'),
    body,
  )

it('asks for encrypted reasoning', () => {
  const request = withEncryptedReasoning(responses({ model: 'gpt-5.6-sol' }))

  expect(sent(request).include).toEqual(['reasoning.encrypted_content'])
  expect(sent(request).model).toBe('gpt-5.6-sol')
})

it('adds to an existing include list rather than replacing it', () => {
  const request = withEncryptedReasoning(responses({ include: ['message.output_text.logprobs'] }))

  expect(sent(request).include).toEqual([
    'message.output_text.logprobs',
    'reasoning.encrypted_content',
  ])
})

it('does not add the same include twice', () => {
  const request = withEncryptedReasoning(responses({ include: ['reasoning.encrypted_content'] }))

  expect(sent(request).include).toEqual(['reasoning.encrypted_content'])
})

const credential = (accessToken: string, accountId: string): Credential => ({
  accessToken: Redacted.make(accessToken),
  accountId: Redacted.make(accountId),
})

// The credentials port, faked: the decoration is tested against a port that answers
// each read with `current`, and no auth file is written for it.
const port = (current: Effect.Effect<Credential, CodexAuthenticationRequired>): CodexCredentials =>
  CodexCredentials.of({ current })

// A client that answers everything with an empty 200 and keeps every request it was
// handed, which is the part `authenticate` is responsible for.
const recorder = () => {
  const seen: Array<HttpClientRequest.HttpClientRequest> = []

  const client = HttpClient.make((request) => {
    seen.push(request)

    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })))
  })

  return { client, seen: () => seen, sent: () => seen[seen.length - 1] }
}

it.live('every request carries the stored credentials and names this client', () =>
  Effect.gen(function* () {
    const recorded = recorder()

    const client = authenticate(port(Effect.succeed(credential('access-token', 'account-id'))))(
      recorded.client,
    )

    yield* client.execute(responses({ model: 'gpt-5.6-sol' }))

    expect(recorded.sent()?.headers).toMatchObject({
      authorization: 'Bearer access-token',
      'chatgpt-account-id': 'account-id',
      originator: 'vody-code',
    })
  }),
)

it.live('a request goes out asking for encrypted reasoning', () =>
  Effect.gen(function* () {
    const recorded = recorder()

    const client = authenticate(port(Effect.succeed(credential('access-token', 'account-id'))))(
      recorded.client,
    )

    yield* client.execute(responses({ model: 'gpt-5.6-sol' }))

    const request = recorded.sent()

    expect(request === undefined ? [] : sent(request).include).toEqual([
      'reasoning.encrypted_content',
    ])
  }),
)

// The port is read again on every request, not once when the client is built: this is
// what lets a token the person refreshed mid-session be sent on the next request. The
// fake port hands out a different credential per read, so a cached read is caught.
it.live('the credentials are read again for every request, so the next one sends the newest', () =>
  Effect.gen(function* () {
    const recorded = recorder()

    const reads = [
      credential('first-token', 'account-id'),
      credential('second-token', 'account-id'),
    ]

    const client = authenticate(
      port(Effect.sync(() => reads.shift() ?? credential('exhausted', 'account-id'))),
    )(recorded.client)

    yield* client.execute(responses({ model: 'gpt-5.6-sol' }))
    yield* client.execute(responses({ model: 'gpt-5.6-sol' }))

    expect(recorded.sent()?.headers).toMatchObject({ authorization: 'Bearer second-token' })
    expect(recorded.seen()[0]?.headers).toMatchObject({ authorization: 'Bearer first-token' })
  }),
)

it.live('a request is never sent when there are no credentials to sign it with', () =>
  Effect.gen(function* () {
    const recorded = recorder()

    const client = authenticate(
      port(Effect.fail(new CodexAuthenticationRequired({ reason: 'the test refuses to sign in' }))),
    )(recorded.client)

    const exit = yield* Effect.exit(client.execute(responses({ model: 'gpt-5.6-sol' })))

    expect(rendered(exit)).toContain('the test refuses to sign in')
    expect(recorded.sent()).toBeUndefined()
  }),
)

// A body handed over as bytes rather than as text carries no `text` of its own, which
// is the only way the decode in `sent` and in `withEncryptedReasoning` is reached.
it('a body that arrived as bytes is read and added to all the same', () => {
  const request = withEncryptedReasoning(
    HttpClientRequest.bodyUint8Array(
      HttpClientRequest.post('https://chatgpt.com/backend-api/codex/responses'),
      new TextEncoder().encode(JSON.stringify({ model: 'gpt-5.6-sol' })),
      'application/json',
    ),
  )

  expect(sent(request).include).toEqual(['reasoning.encrypted_content'])
  expect(sent(request).model).toBe('gpt-5.6-sol')
})

it('a request with no body of its own is left exactly as it came', () => {
  const request = HttpClientRequest.get('https://chatgpt.com/backend-api/codex/responses')

  expect(withEncryptedReasoning(request)).toBe(request)
})

// A transport that answers everything with an empty 200 and sends nothing anywhere.
const quietTransport = (): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  )

// The model adapter over a port the test chose and a transport it chose — building
// the adapter reads the credentials once, and no request of the model's is made here.
const modelLayer = (
  credentials: CodexCredentials,
  transport: HttpClient.HttpClient = quietTransport(),
): Layer.Layer<LanguageModel.LanguageModel, CodexAuthenticationRequired> =>
  layer.pipe(
    Layer.provide(Layer.succeed(CodexCredentials, credentials)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, transport)),
  )

it.live('the model adapter refuses to build when there are no credentials to sign with', () =>
  Effect.gen(function* () {
    const refusing = port(
      Effect.fail(new CodexAuthenticationRequired({ reason: 'the test refuses to sign in' })),
    )

    const exit = yield* Effect.exit(Effect.scoped(Layer.build(modelLayer(refusing))))

    expect(rendered(exit)).toContain('the test refuses to sign in')
  }),
)

it.live('the model adapter builds once the credentials are there', () =>
  Effect.gen(function* () {
    const context = yield* Effect.scoped(
      Layer.build(modelLayer(port(Effect.succeed(credential('access-token', 'account-id'))))),
    )

    expect(Context.get(context, LanguageModel.LanguageModel)).toBeDefined()
  }),
)

// The adapter driven for one request with the transport recorded. This is the whole
// of what the layer composes — the model named, the effort asked for, nothing stored
// on the provider's side, the decoration's include, and the credentials signed on —
// seen in what goes out, with no provider reached: the response failing to decode is
// the exit, not the assertion.
it.live('a request of the model goes out as the adapter was built to send it', () =>
  Effect.gen(function* () {
    const recorded = recorder()

    const signed = port(Effect.succeed(credential('access-token', 'account-id')))

    const exit = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const built = yield* Layer.build(modelLayer(signed, recorded.client))

          return yield* Context.get(built, LanguageModel.LanguageModel).generateText({
            prompt: 'What is kept?',
          })
        }),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)

    const request = recorded.sent()

    expect(request?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(request?.headers).toMatchObject({
      authorization: 'Bearer access-token',
      'chatgpt-account-id': 'account-id',
      originator: 'vody-code',
    })

    const body = request === undefined ? {} : sent(request)

    expect(body.model).toBe('gpt-5.6-sol')
    expect(body.store).toBe(false)
    expect(body.reasoning?.effort).toBe('high')
    expect(body.include).toEqual(['reasoning.encrypted_content'])
  }),
)
