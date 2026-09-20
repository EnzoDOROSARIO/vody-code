import { OpenAiClient, OpenAiLanguageModel } from '@effect/ai-openai'
import {
  Clock,
  Config,
  Effect,
  Encoding,
  FileSystem,
  Layer,
  Predicate,
  Redacted,
  Schema,
} from 'effect'
import type { LanguageModel } from 'effect/unstable/ai'
import { HttpClient, HttpClientError, HttpClientRequest } from 'effect/unstable/http'

const MODEL = 'gpt-5.6-sol'

// How hard the model thinks before it answers. Left unset, the effort is whatever the
// model defaults to, which OpenAI varies from one release to the next; naming it here
// means a new default cannot quietly change how the agent works.
const REASONING_EFFORT = 'high'

const API_URL = 'https://chatgpt.com/backend-api/codex'

export class CodexAuthenticationRequired extends Schema.TaggedError<CodexAuthenticationRequired>()(
  'CodexAuthenticationRequired',
  { reason: Schema.String },
) {}

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

const required = (reason: string): CodexAuthenticationRequired =>
  new CodexAuthenticationRequired({ reason })

const SIGN_IN = 'not signed in to Codex — run `codex login`'

const authFile = Config.String('CODEX_HOME').pipe(
  Config.orElse(() => Config.String('HOME').pipe(Config.map((home) => `${home}/.codex`))),
  Config.map((home) => `${home}/auth.json`),
)

export interface CodexCredentials {
  readonly accessToken: Redacted.Redacted
  readonly accountId: Redacted.Redacted
}

export const credentials: Effect.Effect<
  CodexCredentials,
  CodexAuthenticationRequired,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  const path = yield* authFile.pipe(Effect.mapError(() => required(SIGN_IN)))

  const contents = yield* fs.readFileString(path).pipe(Effect.mapError(() => required(SIGN_IN)))

  const file = yield* Schema.decodeEffect(AuthFile)(contents).pipe(
    Effect.mapError(() => required('the Codex credential file is not in the expected shape')),
  )

  if (file.tokens === undefined || file.tokens === null) {
    return yield* required(SIGN_IN)
  }

  const payload = file.tokens.access_token.split('.')[1]

  if (payload === undefined) {
    return yield* required('the stored Codex token is not a JWT')
  }

  const claims = yield* Effect.fromResult(Encoding.decodeBase64UrlString(payload)).pipe(
    Effect.flatMap(Schema.decodeEffect(Claims)),
    Effect.mapError(() => required('the stored Codex token is missing its claims')),
  )

  const accountId =
    file.tokens.account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id

  if (accountId === undefined || accountId === null) {
    return yield* required('the Codex credentials carry no ChatGPT account id')
  }

  if (claims.exp * 1000 <= (yield* Clock.currentTimeMillis)) {
    return yield* required('the Codex session has expired — run `codex login`')
  }

  return {
    accessToken: Redacted.make(file.tokens.access_token),
    accountId: Redacted.make(accountId),
  }
})

export const withEncryptedReasoning = (
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  const body = request.body

  if (!Predicate.isTagged(body, 'Uint8Array')) {
    return request
  }

  const payload = JSON.parse(body.text ?? new TextDecoder().decode(body.body))
  const include = Array.isArray(payload.include) ? payload.include : []

  return include.includes('reasoning.encrypted_content')
    ? request
    : HttpClientRequest.bodyJsonUnsafe(request, {
        ...payload,
        include: include.concat('reasoning.encrypted_content'),
      })
}

// Exported for the tests, which reach the headers it sets without standing up the
// whole OpenAI client around it.
export const authenticate =
  (auth: Effect.Effect<CodexCredentials, CodexAuthenticationRequired>) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequestEffect((request) =>
        auth.pipe(
          Effect.mapError(
            (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause }),
              }),
          ),
          Effect.map((found) =>
            withEncryptedReasoning(
              HttpClientRequest.setHeaders(request, {
                authorization: `Bearer ${Redacted.value(found.accessToken)}`,
                'chatgpt-account-id': Redacted.value(found.accountId),
                originator: 'vody-code',
              }),
            ),
          ),
        ),
      ),
    )

export const layer: Layer.Layer<
  LanguageModel.LanguageModel,
  CodexAuthenticationRequired,
  FileSystem.FileSystem | HttpClient.HttpClient
> = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const auth = credentials.pipe(Effect.provideService(FileSystem.FileSystem, fs))

    yield* auth

    return OpenAiLanguageModel.layer({
      model: MODEL,
      config: { reasoning: { effort: REASONING_EFFORT }, store: false },
    }).pipe(
      Layer.provide(OpenAiClient.layer({ apiUrl: API_URL, transformClient: authenticate(auth) })),
    )
  }),
)
