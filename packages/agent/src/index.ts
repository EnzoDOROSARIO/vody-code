import { Effect, Layer, Option, Predicate, Ref, Schema, Stream } from 'effect'

import type { FileSystem, Path } from 'effect'
import type { AiError, Chat, LanguageModel, Prompt, Response, Toolkit } from 'effect/unstable/ai'
import { FetchHttpClient } from 'effect/unstable/http'
import type { ChildProcessSpawner } from 'effect/unstable/process'

import { ToolCall } from './activity.ts'
import type { CodexAuthenticationRequired } from './credentials.ts'
import { CodexCredentials } from './credentials.ts'
import * as Codex from './codex.ts'
import * as Gates from './gates.ts'
import { Judge } from './judge.ts'
import { Request } from './request.ts'
import { toolkitLayer } from './tools/index.ts'

import type { Activity, ToolResult } from './activity.ts'
import type { JudgeCredentialsRequired } from './judge.ts'
import type { Handlers, Tools } from './tools/index.ts'

export { ToolCall } from './activity.ts'

// The TUI now accounts for a failed tool call, so the errors a tool can return are
// part of what this package hands out, not an internal of the toolkit.
export {
  ActRefused,
  CommandRefused,
  CommandTimedOut,
  FileIsBinary,
  FileNotRead,
  FileSystemRefused,
  JudgeDidNotAnswer,
  TextNotFound,
  TextNotUnique,
} from './tools/index.ts'

export { toolkit } from './tools/index.ts'

// The prompt the conversation starts from, and what the workspace has to say for
// itself, are one concern; `prompt.ts` holds it.
export { chat, InstructionsUnreadable } from './prompt.ts'

export { Workspace } from './workspace.ts'

export { JudgeCredentialsRequired } from './judge.ts'

export type { Activity, Impasse, Reply, ToolFailure, ToolResult } from './activity.ts'

export type { Handlers, Tools } from './tools/index.ts'

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

// One call of the model and, if it reached for a tool, the calls after it. This is the
// recursion `answer` wraps, kept apart from it so the Request is provided once around
// the whole Turn: a continuation prompts the model with nothing, and one that provided
// its own Request would replace the person's words with none halfway through. The
// refusal count is the Turn's too, made once in `answer` and carried through every call.
const respond = (
  chat: Chat.Chat,
  tools: Toolkit.WithHandler<Tools>,
  prompt: Prompt.RawInput,
  refusals: Ref.Ref<number>,
): Stream.Stream<Activity, AiError.AiError, LanguageModel.LanguageModel> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const calledTools = yield* Ref.make(false)
      const step = yield* Ref.make(UNTOUCHED)

      const turn = chat.streamText({ prompt, toolkit: tools }).pipe(
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
          const count = yield* Ref.updateAndGet(refusals, (current) => tallied(current, gated))

          if (!reached) {
            return Stream.empty
          }

          return count >= REFUSALS_BEFORE_AN_IMPASSE
            ? Stream.succeed<Activity>({ refusals: count, type: 'impasse' })
            : respond(chat, tools, [], refusals)
        }),
      )

      return Stream.concat(turn, rest)
    }),
  )

/**
 * Stream one Turn: everything the agent does in answer to what the person typed, up to
 * and including its final reply, or the Impasse the Gates brought it to first. The words
 * are the Turn's Request, and a `bash` handler, or anything else running inside the
 * Turn, reads them from `Request` on the first call of the model and on every
 * continuation after a tool result. Each Turn counts its refusals from none.
 */
export const answer = (
  chat: Chat.Chat,
  tools: Toolkit.WithHandler<Tools>,
  request: string,
): Stream.Stream<Activity, AiError.AiError, LanguageModel.LanguageModel> =>
  Stream.unwrap(
    Effect.map(Ref.make(0), (refusals) => respond(chat, tools, request, refusals)),
  ).pipe(Stream.provideService(Request, Option.some(request)))

/**
 * The handlers the agent runs, with both Gates in front of them. The Gates go in
 * under the toolkit, where the hooks are read, so no ungated set is ever built; and
 * this is the one gated set, which the package's tests build on as well, so the agent
 * cannot stop running a Gate without that Gate's own tests saying so. The Judge the
 * Gates consult is left open, for `layer` to give it the real one and the tests a
 * scripted one.
 */
export const handlers: Layer.Layer<
  Handlers,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Judge | Path.Path
> = toolkitLayer.pipe(Layer.provide(Gates.layer))

/**
 * Everything the agent needs from this package. Both models need their credentials to
 * build, so a missing sign-in or a missing Judge key stops the agent before it starts.
 * The credentials port is provided here, with the auth file as its adapter; the model
 * adapter takes the port itself, so a test can put a different one in its place.
 */
export const layer: Layer.Layer<
  LanguageModel.LanguageModel | Handlers,
  CodexAuthenticationRequired | JudgeCredentialsRequired,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = Layer.mergeAll(
  handlers.pipe(Layer.provide(Judge.layer)),
  Codex.layer.pipe(Layer.provide(CodexCredentials.fromAuthFile)),
).pipe(Layer.provide(FetchHttpClient.layer))
