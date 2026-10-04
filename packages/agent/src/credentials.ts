import { Clock, Config, Context, Effect, FileSystem, Layer, Redacted, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'

/**
 * The agent is not signed in to Codex, or what it has stored is no longer good enough
 * to call with. Raised wherever the credentials are read: while the model adapter is
 * built, so a missing sign-in stops the agent before it starts, and again per request,
 * so an expired session is said rather than sent.
 */
export class CodexAuthenticationRequired extends Schema.TaggedError<CodexAuthenticationRequired>()(
  'CodexAuthenticationRequired',
  { reason: Schema.String },
) {}

const authenticationRequired = (reason: string): CodexAuthenticationRequired =>
  new CodexAuthenticationRequired({ reason })

const SIGN_IN = 'not signed in to Codex — run `codex login`'

// The configuration that names the credential file, and the reading of the file
// itself, fail alike: either way the person is not signed in, with nothing more to say
// about it.
const notSignedIn = Effect.mapError(() => authenticationRequired(SIGN_IN))

const AuthFile = Schema.fromJsonString(
  Schema.Struct({
    tokens: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          access_token: Schema.String,
          account_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
)

const Claims = Schema.fromJsonString(
  Schema.Struct({
    exp: Schema.Finite,
    'https://api.openai.com/auth': Schema.optionalKey(
      Schema.Struct({ chatgpt_account_id: Schema.optionalKey(Schema.String) }),
    ),
  }),
)

// Where the Codex CLI keeps its credentials: the Codex home when one is set, the
// person's own `.codex` when it is not.
const authFile = Config.String('CODEX_HOME').pipe(
  Config.orElse(() => Config.String('HOME').pipe(Config.map((home) => `${home}/.codex`))),
  Config.map((home) => `${home}/auth.json`),
)

/** What one read of the credentials yields: the token to sign with, and the account it acts for. */
export interface CredentialFound {
  readonly accessToken: Redacted.Redacted
  readonly accountId: Redacted.Redacted
}

/**
 * The credentials the Codex requests are signed with, as a port: the model adapter
 * composes this, and the auth file is its adapter. Where the file is kept, the shape it
 * must have, and how the stored token is decoded and checked for expiry live here, so
 * the model adapter never touches the file system itself.
 */
// Stryker disable StringLiteral: the key only names the service in a context, and nothing
// else in the package claims a name it could collide with.
export class CodexCredentials extends Context.Service<
  CodexCredentials,
  {
    /**
     * The credentials as they are now. Read again on every call, so a token the person
     * refreshed mid-session is picked up without restarting the agent.
     */
    readonly current: Effect.Effect<CredentialFound, CodexAuthenticationRequired>
  }
>()('agent/CodexCredentials') {
  // Stryker restore StringLiteral
  /**
   * The adapter over the auth file the Codex CLI keeps. Building it reads nothing:
   * whether the credentials are there and good is answered by `current`, when the read
   * happens.
   */
  static readonly fromAuthFile: Layer.Layer<CodexCredentials, never, FileSystem.FileSystem> =
    Layer.effect(
      CodexCredentials,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem

        const current: Effect.Effect<CredentialFound, CodexAuthenticationRequired> = Effect.gen(
          function* () {
            const path = yield* authFile.pipe(notSignedIn)

            const contents = yield* fs.readFileString(path).pipe(notSignedIn)

            const file = yield* Schema.decodeEffect(AuthFile)(contents).pipe(
              Effect.mapError(() =>
                authenticationRequired('the Codex credential file is not in the expected shape'),
              ),
            )

            if (file.tokens === undefined || file.tokens === null) {
              return yield* authenticationRequired(SIGN_IN)
            }

            const payload = file.tokens.access_token.split('.')[1]

            if (payload === undefined) {
              return yield* authenticationRequired('the stored Codex token is not a JWT')
            }

            const claims = yield* Effect.fromResult(Base64Url.decodeString(payload)).pipe(
              Effect.flatMap(Schema.decodeEffect(Claims)),
              Effect.mapError(() =>
                authenticationRequired('the stored Codex token is missing its claims'),
              ),
            )

            const accountId =
              file.tokens.account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id

            // The `??` has already turned a stored null into the token's claim, so the
            // account id here is a string or nothing at all.
            if (accountId === undefined) {
              return yield* authenticationRequired(
                'the Codex credentials carry no ChatGPT account id',
              )
            }

            if (claims.exp * 1000 <= (yield* Clock.currentTimeMillis)) {
              return yield* authenticationRequired(
                'the Codex session has expired — run `codex login`',
              )
            }

            return {
              accessToken: Redacted.make(file.tokens.access_token),
              accountId: Redacted.make(accountId),
            }
          },
        )

        return CodexCredentials.of({ current })
      }),
    )
}
