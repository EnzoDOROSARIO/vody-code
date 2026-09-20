import { BunServices } from '@effect/platform-bun'
import { afterEach, expect, test } from 'bun:test'
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

import { TestClock } from 'effect/testing'

import {
  authenticate,
  CodexAuthenticationRequired,
  credentials,
  withEncryptedReasoning,
} from '#codex.ts'

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

const codexHome = async (authJson: string | undefined): Promise<string> => {
  made += 1

  const home = `/tmp/vody-codex-${made}`

  homes.push(home)

  if (authJson !== undefined) {
    await Bun.write(`${home}/auth.json`, authJson)
  }

  return home
}

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await Bun.$`rm -rf ${home}`.quiet()
  }
})

const read = (home: string, clock: Layer.Layer<never> = Layer.empty) =>
  Effect.runPromiseExit(
    credentials.pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ CODEX_HOME: home })),
          clock,
        ),
      ),
    ),
  )

type Stored = {
  readonly access_token: string
  readonly account_id?: string | null
}

const stored = (tokens: Stored | null): string => JSON.stringify({ auth_mode: 'chatgpt', tokens })

const signedIn = (access: string): string => stored({ access_token: access, account_id: ACCOUNT })

test('reads the token and account id the Codex CLI stored', async () => {
  const access = token(inOneHour)

  const exit = await read(await codexHome(signedIn(access)))

  expect(Exit.isSuccess(exit)).toBe(true)

  if (Exit.isSuccess(exit)) {
    expect(Redacted.value(exit.value.accessToken)).toBe(access)
    expect(Redacted.value(exit.value.accountId)).toBe(ACCOUNT)
  }
})

test('a credential renders as redacted, never as its secret', async () => {
  const access = token(inOneHour)

  const exit = await read(await codexHome(signedIn(access)))

  if (Exit.isSuccess(exit)) {
    expect(Bun.inspect(exit.value.accessToken)).not.toContain(access)
    expect(JSON.stringify(exit.value)).not.toContain(access)
    expect(JSON.stringify(exit.value)).not.toContain(ACCOUNT)
  }
})

test('a failure never quotes the token back', async () => {
  const exit = await read(await codexHome(signedIn('not-a-jwt-but-still-a-secret')))

  expect(Bun.inspect(exit)).not.toContain('not-a-jwt-but-still-a-secret')
})

test('an expired session says to sign in again', async () => {
  const exit = await read(await codexHome(signedIn(token(longExpired))))

  expect(Exit.isFailure(exit) && Bun.inspect(exit)).toContain('expired')
})

test('no credential file asks for a login', async () => {
  const exit = await read(await codexHome(undefined))

  expect(Exit.isFailure(exit) && Bun.inspect(exit)).toContain('codex login')
})

// The TestClock stands still at the epoch, so a token's `exp` is an offset from the
// moment the expiry is measured at and the boundary can be hit dead on rather than
// approached.
const readFrozen = (home: string) => read(home, TestClock.layer())

const refusal = (exit: Exit.Exit<CodexCredentials, CodexAuthenticationRequired>): string =>
  Exit.isFailure(exit) ? Bun.inspect(exit) : 'the credentials were read'

test('a credential file holding no tokens asks for a login', async () => {
  const exit = await read(await codexHome(JSON.stringify({ auth_mode: 'chatgpt' })))

  expect(refusal(exit)).toContain('codex login')
})

test('a credential file whose tokens were cleared asks for a login', async () => {
  const exit = await read(await codexHome(stored(null)))

  expect(refusal(exit)).toContain('codex login')
})

test('a credential file of another shape entirely is reported as such', async () => {
  const exit = await read(await codexHome('{"tokens":{"access_token":42}}'))

  expect(refusal(exit)).toContain('not in the expected shape')
})

test('a stored token that is not a JWT is reported as such', async () => {
  const exit = await read(await codexHome(signedIn('not-a-jwt')))

  expect(refusal(exit)).toContain('not a JWT')
})

test('a stored token whose claims will not decode is reported as such', async () => {
  const exit = await read(await codexHome(signedIn(`header.${Encoding.encodeBase64Url('{')}.`)))

  expect(refusal(exit)).toContain('missing its claims')
})

test('falls back to the account id inside the token when none is stored beside it', async () => {
  const exit = await read(await codexHome(stored({ access_token: token(inOneHour) })))

  expect(Exit.isSuccess(exit) && Redacted.value(exit.value.accountId)).toBe(ACCOUNT)
})

test('falls back to the account id inside the token when the stored one was cleared', async () => {
  const exit = await read(
    await codexHome(stored({ access_token: token(inOneHour), account_id: null })),
  )

  expect(Exit.isSuccess(exit) && Redacted.value(exit.value.accountId)).toBe(ACCOUNT)
})

test('prefers the account id stored beside the token to the one inside it', async () => {
  const exit = await read(
    await codexHome(stored({ access_token: token(inOneHour), account_id: 'stored-account' })),
  )

  expect(Exit.isSuccess(exit) && Redacted.value(exit.value.accountId)).toBe('stored-account')
})

test('a login that named no account anywhere is not enough to call with', async () => {
  const exit = await read(await codexHome(stored({ access_token: anonymous(inOneHour) })))

  expect(refusal(exit)).toContain('no ChatGPT account id')
})

test('a cleared account id with none in the token is not enough to call with', async () => {
  const exit = await read(
    await codexHome(stored({ access_token: anonymous(inOneHour), account_id: null })),
  )

  expect(refusal(exit)).toContain('no ChatGPT account id')
})

test('a session is expired the moment it expires, not a second later', async () => {
  const exit = await readFrozen(await codexHome(signedIn(token(0))))

  expect(refusal(exit)).toContain('expired')
})

test('a session with a second left on it is still good', async () => {
  const exit = await readFrozen(await codexHome(signedIn(token(1))))

  expect(Exit.isSuccess(exit)).toBe(true)
})

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

test('asks for encrypted reasoning', () => {
  const request = withEncryptedReasoning(responses({ model: 'gpt-5.6-sol' }))

  expect(sent(request).include).toEqual(['reasoning.encrypted_content'])
  expect(sent(request).model).toBe('gpt-5.6-sol')
})

test('adds to an existing include list rather than replacing it', () => {
  const request = withEncryptedReasoning(responses({ include: ['message.output_text.logprobs'] }))

  expect(sent(request).include).toEqual([
    'message.output_text.logprobs',
    'reasoning.encrypted_content',
  ])
})

test('does not add the same include twice', () => {
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

test('every request carries the stored credentials and names this client', async () => {
  const recorded = recorder()

  const client = authenticate(Effect.succeed(credential('access-token', 'account-id')))(
    recorded.client,
  )

  await Effect.runPromise(client.execute(responses({ model: 'gpt-5.6-sol' })))

  expect(recorded.sent()?.headers).toMatchObject({
    authorization: 'Bearer access-token',
    'chatgpt-account-id': 'account-id',
    originator: 'vody-code',
  })
})

test('a request goes out asking for encrypted reasoning', async () => {
  const recorded = recorder()

  const client = authenticate(Effect.succeed(credential('access-token', 'account-id')))(
    recorded.client,
  )

  await Effect.runPromise(client.execute(responses({ model: 'gpt-5.6-sol' })))

  const request = recorded.sent()

  expect(request === undefined ? [] : sent(request).include).toEqual([
    'reasoning.encrypted_content',
  ])
})

test('a request is never sent when there are no credentials to sign it with', async () => {
  const recorded = recorder()

  const client = authenticate(
    Effect.fail(new CodexAuthenticationRequired({ reason: 'the test refuses to sign in' })),
  )(recorded.client)

  const exit = await Effect.runPromiseExit(client.execute(responses({ model: 'gpt-5.6-sol' })))

  expect(Exit.isFailure(exit) && Bun.inspect(exit)).toContain('the test refuses to sign in')
  expect(recorded.sent()).toBeUndefined()
})

// A body handed over as bytes rather than as text carries no `text` of its own, which
// is the only way the decode in `sent` and in `withEncryptedReasoning` is reached.
test('a body that arrived as bytes is read and added to all the same', () => {
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

test('a request with no body of its own is left exactly as it came', () => {
  const request = HttpClientRequest.get('https://chatgpt.com/backend-api/codex/responses')

  expect(withEncryptedReasoning(request)).toBe(request)
})
