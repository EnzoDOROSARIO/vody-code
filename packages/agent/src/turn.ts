import { Effect, Option, Predicate, Ref, Schema, Stream } from 'effect'

import type { AiError, Chat, LanguageModel, Prompt, Response, Toolkit } from 'effect/unstable/ai'

import { ToolCall } from './activity.ts'
import { Request } from './request.ts'

import type { Activity, ToolResult } from './activity.ts'
import type { Tools } from './tools/index.ts'

// The arguments are checked against the same schema the tool itself decodes with, so
// a call that fails here is one the tool is about to refuse. Staying quiet costs
// nothing: the refusal arrives as the very next result, and that result is reported.
const called = (part: Response.ToolCallParts<Tools, 'opaque'>): Stream.Stream<Activity> =>
  Stream.unwrap(
    Schema.decodeUnknownEffect(ToolCall)(part).pipe(
      Effect.map((call): Stream.Stream<Activity> => Stream.succeed(call)),
      Effect.orElseSucceed(() => Stream.empty),
    ),
  )

// Text leaves as it lands, one fragment per part, so whoever is watching can show the
// answer being written rather than waiting for the turn to end. The fragments a model
// writes before reaching for a tool are the agent thinking aloud, and they go out too.
const reported = (part: Response.StreamPart<Tools, 'opaque'>): Stream.Stream<Activity> => {
  if (part.type === 'text-delta') {
    return Stream.succeed({ id: part.id, text: part.delta, type: 'reply' })
  }

  if (part.type === 'tool-call') {
    return called(part)
  }

  return part.type === 'tool-result' ? Stream.succeed(part) : Stream.empty
}

/**
 * How many refusals a Turn takes before it reaches an Impasse. A refusal goes back to the
 * model as a failure to work around, and nothing but the model decides what it tries
 * next: with no person to overrule the Gate, a model that keeps rephrasing would loop, a
 * call to the Judge on every pass, for as long as it liked.
 */
const REFUSALS_BEFORE_AN_IMPASSE = 3

// Which tools pass a Gate. Only a gated act that was allowed says the model has found a
// way through, so only those clear the count; reading and searching always succeed, and
// a model that reads between attempts, as one does when something is not working, would
// otherwise clear it every time. The tool's name is the fact read here rather than a
// signal out of the Gate, because the write Gate lets writes inside the Perimeter through
// unjudged, and those are allowed acts too: whether the Judge was asked does not matter,
// only that the tool is one a Gate stands in front of. The record names every tool, so a
// new one is a compile error until someone says which side of this line it is on.
const GATED = {
  bash: true,
  edit_file: true,
  glob: false,
  read_file: false,
  write_file: true,
} satisfies { readonly [Name in ToolResult['name']]: boolean }

// A refusal is either failure a Gate returns: an act the Judge judged and was refused, or
// one refused because the Judge did not answer. Both mean the act did not happen for
// reasons the model cannot argue with, so both count. Read by tag, on any tool, so a tool
// that gains a Gate is counted without being named here.
const refused = (result: ToolResult): boolean =>
  result.isFailure &&
  (Predicate.isTagged(result.result, 'ActRefused') ||
    Predicate.isTagged(result.result, 'JudgeDidNotAnswer'))

/** What one call of the model met at the Gates, across every tool it reached for. */
type Step = {
  readonly allowed: boolean
  readonly refused: number
}

const UNTOUCHED: Step = { allowed: false, refused: 0 }

// Any other failure, a file not found or an edit that matched nothing, is the model's to
// fix and says nothing about the Gate either way.
const met = (step: Step, result: ToolResult): Step => {
  if (refused(result)) {
    return { ...step, refused: step.refused + 1 }
  }

  return !result.isFailure && GATED[result.name] ? { ...step, allowed: true } : step
}

// The count after one call of the model. The tools a call reached for run concurrently,
// so their results arrive in whatever order they finish, and a model that asked for them
// all at once saw none of them before asking: inside one call nothing comes between
// anything else. So the rule reads the call as a whole. Its refusals add up, and only a
// call that got a gated act through and was refused nothing clears the count.
const tallied = (refusals: number, step: Step): number =>
  step.allowed && step.refused === 0 ? 0 : refusals + step.refused

/** What one Turn's loop carries through every call of the model: the conversation it
 * continues, the handlers it reaches for, and the Turn's refusal count, made once in
 * `answer` and cleared only by a call that got a gated act through and was refused
 * nothing. The words of the moment vary call to call, so they are `respond`'s own
 * argument and not part of this. */
type Turn = {
  readonly chat: Chat.Chat
  readonly refusals: Ref.Ref<number>
  readonly tools: Toolkit.WithHandler<Tools>
}

// One call of the model and, if it reached for a tool, the calls after it. This is the
// recursion `answer` wraps, kept apart from it so the Request is provided once around
// the whole Turn: a continuation prompts the model with nothing, and one that provided
// its own Request would replace the person's words with none halfway through.
const respond = (
  turn: Turn,
  prompt: Prompt.RawInput,
): Stream.Stream<Activity, AiError.AiError, LanguageModel.LanguageModel> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const calledTools = yield* Ref.make(false)
      const step = yield* Ref.make(UNTOUCHED)

      const call = turn.chat.streamText({ prompt, toolkit: turn.tools }).pipe(
        Stream.tap((part) => {
          if (part.type === 'tool-call') {
            return Ref.set(calledTools, true)
          }

          return part.type === 'tool-result'
            ? Ref.update(step, (current) => met(current, part))
            : Effect.void
        }),
        Stream.flatMap(reported),
      )

      // A turn that reached for a tool has not answered yet. The empty prompt sends
      // the model back in with the results the chat is already holding, unless the Gates
      // have refused enough for an Impasse instead, which is said as the Turn's last
      // Activity so nobody waits for an answer. A turn that did not reach for a tool has
      // already said everything it had to say, fragment by fragment.
      const rest = Stream.unwrap(
        Effect.gen(function* () {
          const reached = yield* Ref.get(calledTools)
          const gated = yield* Ref.get(step)
          const count = yield* Ref.updateAndGet(turn.refusals, (current) => tallied(current, gated))

          if (!reached) {
            return Stream.empty
          }

          return count >= REFUSALS_BEFORE_AN_IMPASSE
            ? Stream.succeed<Activity>({ refusals: count, type: 'impasse' })
            : respond(turn, [])
        }),
      )

      return Stream.concat(call, rest)
    }),
  )

// A call of the model that broke ends the Turn the way the Gates ending it does: the
// loop's own report, said as the Turn's last Activity, so nobody is left waiting for an
// answer that is not coming. The reason is the failure's own sentence, which is all the
// model had to say about why.
const broken = (error: AiError.AiError): Stream.Stream<Activity> =>
  Stream.succeed({ reason: error.message, type: 'breakdown' })

/**
 * Stream one Turn: everything the agent does in answer to what the person typed, up to
 * and including its final reply, or the Impasse the Gates brought it to first, or the
 * Breakdown a model that failed brought it to. The words are the Turn's Request, and a
 * `bash` handler, or anything else running inside the Turn, reads them from `Request` on
 * the first call of the model and on every continuation after a tool result. Each Turn
 * counts its refusals from none.
 *
 * The stream does not fail: a call of the model that breaks is reported as the
 * Breakdown, the Turn's last Activity, so whoever runs the Turn to its end — the
 * session's ask — is total, and the transcript says why the Turn ended.
 */
export const answer = (
  chat: Chat.Chat,
  tools: Toolkit.WithHandler<Tools>,
  request: string,
): Stream.Stream<Activity, never, LanguageModel.LanguageModel> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const turn: Turn = { chat, refusals: yield* Ref.make(0), tools }

      return respond(turn, request)
    }),
  ).pipe(Stream.provideService(Request, Option.some(request)), Stream.catchTag('AiError', broken))
