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
import { HttpClientRequest } from 'effect/unstable/http'

import { credentials, withEncryptedReasoning } from './codex.ts'

const ACCOUNT = 'fake-account-id'

const token = (exp: number): string =>
  [
    Encoding.encodeBase64Url('{"alg":"none"}'),
    Encoding.encodeBase64Url(
      JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT } }),
    ),
    '',
  ].join('.')

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

const read = (home: string) =>
  Effect.runPromiseExit(
    credentials.pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ CODEX_HOME: home })),
        ),
      ),
    ),
  )

const signedIn = (access: string): string =>
  JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: access, account_id: ACCOUNT } })

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

const responses = (body: typeof Body.Type): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post('/responses'), body)

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
