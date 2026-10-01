import { afterEach, expect, it } from '@effect/vitest'
import { NodeServices } from '@effect/platform-node'
import {
  Clock,
  ConfigProvider,
  Effect,
  Encoding,
  Exit,
  Layer,
  Predicate,
  Redacted,
  Schema,
} from 'effect'
import { HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'
import * as Fs from 'node:fs/promises'
import * as Util from 'node:util'

import { TestClock } from 'effect/testing'

import {
  authenticate,
  CodexAuthenticationRequired,
  credentials,
  withEncryptedReasoning,
} from '#codex.ts'

import { rendered, write } from './testing.ts'
import type { CodexCredentials } from '#codex.ts'

const ACCOUNT = 'fake-account-id'

type Claims = {
  readonly exp: number
  readonly 'https://api.openai.com/auth'?: { readonly chatgpt_account_id: string }
}

const jwt = (claims: Claims): string =>
  [
    Encoding.encodeBase64Url('{"alg":"none"}'),
    Encoding.encodeBase64Url(JSON.stringify(claims)),
    '',
  ].join('.')

const token = (exp: number): string =>
  jwt({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT } })

// A token from a login that named no account of its own, which is where the account
// id stored beside it is the only one there is.
const anonymous = (exp: number): string => jwt({ exp })

const now = Math.floor(Effect.runSync(Clock.currentTimeMillis) / 1000)

const inOneHour = now + 3600

const longExpired = now - 3600

const homes: Array<string> = []

let made = 0

const codexHome = (authJson: string | undefined): Effect.Effect<string> =>
  Effect.promise(async () => {
    made += 1

    const home = `/tmp/vody-codex-${made}`

    homes.push(home)

    if (authJson !== undefined) {
      await write(`${home}/auth.json`, authJson)
    }

    return home
  })

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await Fs.rm(home, { recursive: true, force: true })
  }
})

const read = (
  home: string,
  clock: Layer.Layer<never> = Layer.empty,
): Effect.Effect<Exit.Exit<CodexCredentials, CodexAuthenticationRequired>> =>
  credentials.pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromEnvRecord({ CODEX_HOME: home })),
        clock,
      ),
    ),
    Effect.exit,
  )

type Stored = {
  readonly access_token: string
  readonly account_id?: string | null
}

const stored = (tokens: Stored | null): string => JSON.stringify({ auth_mode: 'chatgpt', tokens })

const signedIn = (access: string): string => stored({ access_token: access, account_id: ACCOUNT })

it.live('reads the token and account id the Codex CLI stored', () =>
  Effect.gen(function* () {
    const access = token(inOneHour)

    const exit = yield* read(yield* codexHome(signedIn(access)))

    expect(Exit.isSuccess(exit)).toBe(true)

    if (Exit.isSuccess(exit)) {
      expect(Redacted.value(exit.value.accessToken)).toBe(access)
      expect(Redacted.value(exit.value.accountId)).toBe(ACCOUNT)
    }
  }),
)

it.live('a credential renders as redacted, never as its secret', () =>
  Effect.gen(function* () {
    const access = token(inOneHour)

    const exit = yield* read(yield* codexHome(signedIn(access)))

    if (Exit.isSuccess(exit)) {
      expect(Util.inspect(exit.value.accessToken)).not.toContain(access)
      expect(JSON.stringify(exit.value)).not.toContain(access)
      expect(JSON.stringify(exit.value)).not.toContain(ACCOUNT)
    }
  }),
)

it.live('a failure never quotes the token back', () =>
  Effect.gen(function* () {
    const exit = yield* read(yield* codexHome(signedIn('not-a-jwt-but-still-a-secret')))

    expect(Util.inspect(exit)).not.toContain('not-a-jwt-but-still-a-secret')
  }),
)

it.live('an expired session says to sign in again', () =>
  Effect.gen(function* () {
    const exit = yield* read(yield* codexHome(signedIn(token(longExpired))))

    expect(rendered(exit)).toContain('expired')
  }),
)

it.live('no credential file asks for a login', () =>
  Effect.gen(function* () {
    const exit = yield* read(yield* codexHome(undefined))

    expect(rendered(exit)).toContain('codex login')
  }),
)

// The TestClock stands still at the epoch, so a token's `exp` is an offset from the
// moment the expiry is measured at and the boundary can be hit dead on rather than
// approached.
const readFrozen = (home: string) => read(home, TestClock.layer())

const refusal = (exit: Exit.Exit<CodexCredentials, CodexAuthenticationRequired>): string =>
  Exit.isFailure(exit) ? rendered(exit) : 'the credentials were read'

it.live('a credential file holding no tokens asks for a login', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(yield* codexHome(JSON.stringify({ auth_mode: 'chatgpt' })))

    expect(refusal(exit)).toContain('codex login')
  }),
)

it.live('a credential file whose tokens were cleared asks for a login', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(yield* codexHome(stored(null)))

    expect(refusal(exit)).toContain('codex login')
  }),
)

it.live('a credential file of another shape entirely is reported as such', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(yield* codexHome('{"tokens":{"access_token":42}}'))

    expect(refusal(exit)).toContain('not in the expected shape')
  }),
)

it.live('a stored token that is not a JWT is reported as such', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(yield* codexHome(signedIn('not-a-jwt')))

    expect(refusal(exit)).toContain('not a JWT')
  }),
)

it.live('a stored token whose claims will not decode is reported as such', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(
      yield* codexHome(signedIn(`header.${Encoding.encodeBase64Url('{')}.`)),
    )

    expect(refusal(exit)).toContain('missing its claims')
  }),
)

it.live('falls back to the account id inside the token when none is stored beside it', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(yield* codexHome(stored({ access_token: token(inOneHour) })))

    expect(Exit.isSuccess(exit) && Redacted.value(exit.value.accountId)).toBe(ACCOUNT)
  }),
)

it.live('falls back to the account id inside the token when the stored one was cleared', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(
      yield* codexHome(stored({ access_token: token(inOneHour), account_id: null })),
    )

    expect(Exit.isSuccess(exit) && Redacted.value(exit.value.accountId)).toBe(ACCOUNT)
  }),
)

it.live('prefers the account id stored beside the token to the one inside it', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(
      yield* codexHome(stored({ access_token: token(inOneHour), account_id: 'stored-account' })),
    )

    expect(Exit.isSuccess(exit) && Redacted.value(exit.value.accountId)).toBe('stored-account')
  }),
)

it.live('a login that named no account anywhere is not enough to call with', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(yield* codexHome(stored({ access_token: anonymous(inOneHour) })))

    expect(refusal(exit)).toContain('no ChatGPT account id')
  }),
)

it.live('a cleared account id with none in the token is not enough to call with', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(
      yield* codexHome(stored({ access_token: anonymous(inOneHour), account_id: null })),
    )

    expect(refusal(exit)).toContain('no ChatGPT account id')
  }),
)

it.live('a session is expired the moment it expires, not a second later', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(yield* codexHome(signedIn(token(0))))

    expect(refusal(exit)).toContain('expired')
  }),
)

it.live('a session with a second left on it is still good', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(yield* codexHome(signedIn(token(1))))

    expect(Exit.isSuccess(exit)).toBe(true)
  }),
)

const Body = Schema.Struct({
  include: Schema.optionalKey(Schema.Array(Schema.String)),
  model: Schema.optionalKey(Schema.String),
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

const credential = (accessToken: string, accountId: string): CodexCredentials => ({
  accessToken: Redacted.make(accessToken),
  accountId: Redacted.make(accountId),
})

// A client that answers everything with an empty 200 and keeps the request it was
// handed, which is the part `authenticate` is responsible for.
const recorder = () => {
  let seen: HttpClientRequest.HttpClientRequest | undefined

  const client = HttpClient.make((request) => {
    seen = request

    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })))
  })

  return { client, sent: () => seen }
}

it.live('every request carries the stored credentials and names this client', () =>
  Effect.gen(function* () {
    const recorded = recorder()

    const client = authenticate(Effect.succeed(credential('access-token', 'account-id')))(
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

    const client = authenticate(Effect.succeed(credential('access-token', 'account-id')))(
      recorded.client,
    )

    yield* client.execute(responses({ model: 'gpt-5.6-sol' }))

    const request = recorded.sent()

    expect(request === undefined ? [] : sent(request).include).toEqual([
      'reasoning.encrypted_content',
    ])
  }),
)

it.live('a request is never sent when there are no credentials to sign it with', () =>
  Effect.gen(function* () {
    const recorded = recorder()

    const client = authenticate(
      Effect.fail(new CodexAuthenticationRequired({ reason: 'the test refuses to sign in' })),
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
