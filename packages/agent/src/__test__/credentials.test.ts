import { afterEach, expect, it } from '@effect/vitest'
import { NodeServices } from '@effect/platform-node'
import { Clock, ConfigProvider, Effect, Encoding, Exit, Layer, Redacted } from 'effect'
import * as Fs from 'node:fs/promises'
import * as Util from 'node:util'

import { TestClock } from 'effect/testing'

import { CodexCredentials } from '#credentials.ts'

import { rendered, write } from './testing.ts'
import type { CodexAuthenticationRequired, CredentialFound } from '#credentials.ts'

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

// Run `use` against the file-backed adapter's port, with `env` as the configuration
// it reads its home from. The layers the adapter's reads ride on are merged in
// afterwards, where the file system they read through is provided rather than made
// to wait on.
const withCredentials = <A>(
  env: Record<string, string>,
  use: (credentials: CodexCredentials['Service']) => Effect.Effect<A, CodexAuthenticationRequired>,
  clock: Layer.Layer<never> = Layer.empty,
): Effect.Effect<A, CodexAuthenticationRequired> =>
  Effect.gen(function* () {
    const credentials = yield* CodexCredentials

    return yield* use(credentials)
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
    Effect.provide(
      CodexCredentials.fromAuthFile.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
        Layer.provideMerge(clock),
      ),
    ),
  )

// A read of the credentials, with `home` as the Codex home.
const read = (
  home: string,
  clock?: Layer.Layer<never>,
): Effect.Effect<Exit.Exit<CredentialFound, CodexAuthenticationRequired>> =>
  withCredentials({ CODEX_HOME: home }, (credentials) => credentials.current, clock).pipe(
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

    const cause = rendered(exit)

    // The failure is the one the agent layer is built to refuse on, by its name —
    // it is what a composition that wants to react to it would catch.
    expect(cause).toContain('CodexAuthenticationRequired')
    expect(cause).toContain('codex login')
  }),
)

// The TestClock stands still at the epoch, so a token's `exp` is an offset from the
// moment the expiry is measured at and the boundary can be hit dead on rather than
// approached.
const readFrozen = (home: string) => read(home, TestClock.layer())

const refusal = (exit: Exit.Exit<CredentialFound, CodexAuthenticationRequired>): string =>
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

// What the per-request re-read is for: one built adapter, two reads, and the file
// rewritten in between — the way a `codex login` while the agent runs shows up. The
// second read must see the refresh; caching the first read would send the old token.
it.live('the credentials are read again on every read, so a refreshed token is picked up', () =>
  Effect.gen(function* () {
    const home = yield* codexHome(signedIn(token(inOneHour)))

    const refreshed = token(inOneHour + 1)

    const tokens = yield* withCredentials({ CODEX_HOME: home }, (credentials) =>
      Effect.gen(function* () {
        const first = yield* credentials.current
        yield* Effect.promise(() => write(`${home}/auth.json`, signedIn(refreshed)))
        const second = yield* credentials.current

        return [Redacted.value(first.accessToken), Redacted.value(second.accessToken)]
      }),
    )

    expect(tokens[0]).toBe(token(inOneHour))
    expect(tokens[1]).toBe(refreshed)
  }),
)

// The configuration has a fallback: the Codex home is CODEX_HOME when it is set, and
// the person's own `.codex` when it is not. The fallback is a path of its own, so a
// file left where the fallback looks is the fixture that reaches it.
it.live("the Codex home falls back to the person's own .codex when no CODEX_HOME is set", () =>
  Effect.gen(function* () {
    const home = yield* codexHome(undefined)

    const access = token(inOneHour)

    yield* Effect.promise(() => write(`${home}/.codex/auth.json`, signedIn(access)))

    const found = yield* withCredentials({ HOME: home }, (credentials) => credentials.current)

    expect(Redacted.value(found.accessToken)).toBe(access)
  }),
)

// Neither name set is a home nowhere, and a home nowhere is not a file to read: the
// configuration itself refusing is the login's asking, not a file that failed to.
it.live('a Codex home nowhere asks for a login', () =>
  Effect.gen(function* () {
    const exit = yield* withCredentials({}, (credentials) => Effect.exit(credentials.current))

    expect(rendered(exit)).toContain('codex login')
  }),
)

// The expiry is a fact of the claims: a token that decodes but carries no `exp` has
// nothing to check, and nothing to check is not a session to trust.
it.live('a token whose claims carry no expiry is not good enough to call with', () =>
  Effect.gen(function* () {
    const exit = yield* readFrozen(
      yield* codexHome(signedIn(`header.${Encoding.encodeBase64Url('{}')}.`)),
    )

    expect(refusal(exit)).toContain('missing its claims')
  }),
)

it.live('an account claim of another shape is not good enough to call with', () =>
  Effect.gen(function* () {
    const payload = Encoding.encodeBase64Url(
      JSON.stringify({
        exp: inOneHour,
        'https://api.openai.com/auth': { chatgpt_account_id: 42 },
      }),
    )

    const exit = yield* readFrozen(yield* codexHome(signedIn(`header.${payload}.`)))

    expect(refusal(exit)).toContain('missing its claims')
  }),
)
