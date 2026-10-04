import { Effect, Option, Predicate, Ref, Schema, Stream } from 'effect'

import { Prompt } from 'effect/ai'

import type { AiError, Chat, LanguageModel, Response, Toolkit } from 'effect/ai'

import { ToolCall } from './activity.ts'
import { Request } from './request.ts'
import { watched } from './tools/hooks.ts'
import { PlanHolder, fresh } from './tools/plan.ts'

import type { Activity, ToolResult } from './activity.ts'
import type { Tools } from './tools/index.ts'
import type { Step, Written } from './tools/plan.ts'

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

/**
 * How many calls of the model a Turn goes without writing the Plan before the loop
 * reminds the agent of it. Three is a guess to watch and tune: long enough that a Step
 * taking a call or two of its own is left to work, short enough that drift is caught
 * before the answer is written on the wrong footing.
 */
const CALLS_BEFORE_A_REMINDER = 3

// A refusal is either failure a Gate returns: an act the Judge judged and was refused, or
// one refused because the Judge did not answer. Both mean the act did not happen for
// reasons the model cannot argue with, so both count. Read by tag, on any tool, so a tool
// that gains a Gate is counted without being named here. Which tools a Gate stands in
// front of is not read here at all: the seam records every gated act that got through,
// and that record is the whole of what "allowed" means. Only a gated act that was allowed
// says the model has found a way through, so only those clear the count; reading and
// searching are never recorded, and a model that reads between attempts, as one does when
// something is not working, does not clear it every time.
const refused = (result: ToolResult): boolean =>
  result.isFailure &&
  (Predicate.isTagged(result.result, 'ActRefused') ||
    Predicate.isTagged(result.result, 'JudgeDidNotAnswer'))

/** What one call of the model met at the Gates: the refusals it was given to work around.
 * Whether a gated act got through is not part of this — the seam recorded it, and the
 * loop reads that separately. The name keeps `Step` for the Plan, as the glossary has it. */
type RefusalStep = {
  readonly refused: number
}

const UNTOUCHED: RefusalStep = { refused: 0 }

// Any other failure, a file not found or an edit that matched nothing, is the model's to
// fix and says nothing about the Gate either way.
const met = (counted: RefusalStep, result: ToolResult): RefusalStep =>
  refused(result) ? { ...counted, refused: counted.refused + 1 } : counted

// The count after one call of the model. The tools a call reached for run concurrently,
// so their results arrive in whatever order they finish, and a model that asked for them
// all at once saw none of them before asking: inside one call nothing comes between
// anything else. So the rule reads the call as a whole. Its refusals add up, and only a
// call the seam recorded a passage for and that was refused nothing clears the count.
const tallied = (refusals: number, counted: RefusalStep, passed: boolean): number =>
  passed && counted.refused === 0 ? 0 : refusals + counted.refused

/** What the loop knows about reminding the agent of its Plan. A Turn starts unarmed, and
 * only a write of its Plan arms the Reminder: an unarmed state carries nothing but the
 * write count the loop last saw, an armed one adds how many calls of the model have gone
 * by since. That count is what lets the loop tell a call that wrote the Plan from one
 * that only followed a write. */
type ReminderState =
  | { readonly armed?: false; readonly writes: number }
  | { readonly armed: true; readonly calls: number; readonly writes: number }

const UNARMED: ReminderState = { writes: 0 }

// The Reminder's state after one call of the model that reached for a tool. A write
// anywhere among the call's tools arms it afresh, with the count at zero; a call that
// wrote nothing moves an armed count on by one, and leaves an unarmed state alone,
// because only a write of this Turn's Plan can arm the Reminder.
const reminded = (state: ReminderState, written: Written): ReminderState => {
  if (written.writes > state.writes) {
    return { armed: true, calls: 0, writes: written.writes }
  }

  // Stryker disable next-line ConditionalExpression,BlockStatement: an unarmed state's
  // count is never read — only a write arms the Reminder, and that arms afresh with the
  // count at zero — so whether this branch moves it or leaves it cannot be observed.
  if (state.armed !== true) {
    return state
  }

  return { ...state, calls: state.calls + 1 }
}

// The Reminder's words: the Plan as it stands, said to the model by the harness rather
// than the person, with every Step and its status in the words `write_plan` taught, and
// the way out if the Plan no longer matches the work. The words are pinned by a test;
// changing them is a deliberate act.
const reminder = (steps: ReadonlyArray<Step>): string =>
  [
    'Reminder from the harness: your Plan still has unfinished Steps. This is the Plan as you last wrote it:',
    ...steps.map((step) => `- ${step.text} (${step.status})`),
    'If the Plan no longer matches the work, write it again with write_plan.',
  ].join('\n')

// The Reminder reaches the model the way the harness speaks: one system message of its
// own, after the history the call already carries, never as though the person had typed
// it. One message, and no other: the empty continuation is a Prompt too.
const reminderPrompt = (steps: ReadonlyArray<Step>): Prompt.Prompt =>
  Prompt.make([Prompt.systemMessage({ content: reminder(steps) })])

/** What one Turn's loop carries through every call of the model: the conversation it
 * continues, the handlers it reaches for, the Turn's refusal count, made once in
 * `answer` and cleared only by a call that got a gated act through and was refused
 * nothing, the reader of the Turn's own holder of the Plan, and the Reminder's state,
 * which only a write of the Plan in this Turn arms. The words of the moment vary call to
 * call, so they are `respond`'s own argument and not part of this. */
type Turn = {
  readonly chat: Chat.Chat
  readonly refusals: Ref.Ref<number>
  readonly reminder: Ref.Ref<ReminderState>
  readonly tools: Toolkit.WithHandler<Tools>
  readonly written: Effect.Effect<Written>
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
      const counted = yield* Ref.make(UNTOUCHED)

      // One Passage per call of the model: what this call's Gates let through cannot
      // clear the count of the call after it.
      const watchedCall = yield* watched(turn.chat.streamText({ prompt, toolkit: turn.tools }))

      const call = watchedCall.stream.pipe(
        Stream.tap((part) => {
          if (part.type === 'tool-call') {
            return Ref.set(calledTools, true)
          }

          // Stryker disable next-line ConditionalExpression: `met` changes nothing for a
          // part that is not a tool result, so taken or not the branch is unobservable.
          if (part.type === 'tool-result') {
            return Ref.update(counted, (current) => met(current, part))
          }

          return Effect.void
        }),
        Stream.flatMap(reported),
      )

      // A turn that reached for a tool has not answered yet. The empty prompt sends
      // the model back in with the results the chat is already holding, unless the Gates
      // have refused enough for an Impasse instead, which is said as the Turn's last
      // Activity so nobody waits for an answer, or unless the Plan written this Turn has
      // gone unrewritten long enough to be worth putting back in front of the model. A
      // turn that did not reach for a tool has already said everything it had to say,
      // fragment by fragment.
      const rest = Stream.unwrap(
        Effect.gen(function* () {
          const reached = yield* Ref.get(calledTools)
          const gated = yield* Ref.get(counted)
          const passed = yield* watchedCall.passed

          const count = yield* Ref.updateAndGet(turn.refusals, (current) =>
            tallied(current, gated, passed),
          )

          if (!reached) {
            return Stream.empty
          }

          // The call is read as a whole: a write anywhere among its tools is one write,
          // and the count it leaves behind starts at zero. A call that wrote nothing
          // moves an armed count on by one; an unarmed one changes nothing, because only
          // a write of this Turn's Plan can arm the Reminder.
          const written = yield* turn.written

          const next = reminded(yield* Ref.get(turn.reminder), written)

          yield* Ref.set(turn.reminder, next)

          if (count >= REFUSALS_BEFORE_AN_IMPASSE) {
            return Stream.succeed<Activity>({ refusals: count, type: 'impasse' })
          }

          const unfinished = written.steps.some((step) => step.status !== 'completed')

          if (next.armed !== true || next.calls < CALLS_BEFORE_A_REMINDER || !unfinished) {
            return respond(turn, [])
          }

          // At most one Reminder for each write: delivering it disarms, and only the
          // next write arms it again.
          yield* Ref.set(turn.reminder, { writes: next.writes })

          return Stream.concat(
            Stream.succeed<Activity>({ steps: written.steps, type: 'reminder' }),
            respond(turn, reminderPrompt(written.steps)),
          )
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
 * counts its refusals from none, holds the Turn's own holder of the Plan — fresh, so
 * only a write made in this Turn can arm the Reminder — and starts unarmed.
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
      const { holder, written } = yield* fresh

      const turn: Turn = {
        chat,
        refusals: yield* Ref.make(0),
        reminder: yield* Ref.make<ReminderState>(UNARMED),
        tools,
        written,
      }

      return respond(turn, request).pipe(Stream.provideService(PlanHolder, holder))
    }),
  ).pipe(Stream.provideService(Request, Option.some(request)), Stream.catchTag('AiError', broken))
