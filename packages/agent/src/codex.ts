import { OpenAiClient, OpenAiLanguageModel } from '@effect/ai-openai'
import { Effect, Layer, Predicate, Redacted } from 'effect'
import type { LanguageModel } from 'effect/unstable/ai'
import { HttpClient, HttpClientError, HttpClientRequest } from 'effect/unstable/http'

import type { CodexAuthenticationRequired } from './credentials.ts'
import { CodexCredentials } from './credentials.ts'

const MODEL = 'gpt-5.6-sol'

// How hard the model thinks before it answers. Left unset, the effort is whatever the
// model defaults to, which OpenAI varies from one release to the next; naming it here
// means a new default cannot quietly change how the agent works.
const REASONING_EFFORT = 'high'

const API_URL = 'https://chatgpt.com/backend-api/codex'

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
  (credentials: CodexCredentials) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequestEffect((request) =>
        credentials.current.pipe(
          Effect.mapError(
            // A credential failure rides as a transport error because the seam this
            // decoration is applied at forces it to. `mapRequestEffect` itself would
            // let the real error through — its transform may fail with anything — but
            // `OpenAiClient`'s `transformClient` option takes and returns the plain
            // `HttpClient`, whose error channel is fixed at `HttpClientError`, and a
            // client that could also fail with `CodexAuthenticationRequired` is not an
            // `HttpClient`. Of that error's reasons there is no authentication one, so
            // the credential failure is wrapped as a `TransportError` and carried as
            // its cause — and the OpenAI client, turning the transport error into a
            // network error of its own, leaves the cause behind. What reaches the
            // conversation says the network failed, not that signing in again would
            // fix it.
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
  CodexCredentials | HttpClient.HttpClient
> = Layer.unwrap(
  Effect.gen(function* () {
    const credentials = yield* CodexCredentials

    // The model needs its credentials to build, so a missing sign-in stops the agent
    // before it starts; every request still reads them again below, so a token the
    // person refreshed mid-session is picked up without a restart.
    yield* credentials.current

    return OpenAiLanguageModel.layer({
      model: MODEL,
      config: { reasoning: { effort: REASONING_EFFORT }, store: false },
    }).pipe(
      Layer.provide(
        OpenAiClient.layer({ apiUrl: API_URL, transformClient: authenticate(credentials) }),
      ),
    )
  }),
)
