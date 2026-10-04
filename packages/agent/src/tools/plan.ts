import { Context, Effect, Ref, Schema } from 'effect'

/** Where one Step of the Plan stands: the three states the agent can mark it with. */
export const Status = Schema.Literals(['pending', 'in_progress', 'completed'])

export type Status = typeof Status.Type

// A Step with nothing to read is not a Step: `Schema.isNonEmpty` would take `'   '`, so
// the rule is the text that survives a trim. The message is the model's, not the
// screen's: it is what the refusal says when it comes back.
const notBlank = Schema.makeFilter((text: string) => text.trim().length > 0, {
  message: 'Step text must not be empty or whitespace only',
})

/** One piece of the work in the Plan: what it is, and how far along it is. */
export const Step = Schema.Struct({
  status: Status,
  text: Schema.String.check(notBlank),
})

export type Step = typeof Step.Type

// "What is it doing now" has one answer: a Plan with two Steps in progress has none.
const atMostOneInProgress = Schema.makeFilter(
  (steps: ReadonlyArray<Step>) => steps.filter((step) => step.status === 'in_progress').length <= 1,
  { message: 'Plan must have at most one step in progress' },
)

/** The Plan itself: its Steps, in order, at most twenty of them. */
export const Steps = Schema.Array(Step)
  .check(Schema.isMaxLength(20, { message: 'A Plan holds at most 20 steps' }))
  .check(atMostOneInProgress)

export type Steps = typeof Steps.Type

/** The Plan as it stands, and how many accepted writes it took to get there: the loop
 * compares the count it last saw to tell one call of the model that wrote from one that
 * did not. */
export type Written = {
  readonly steps: ReadonlyArray<Step>
  readonly writes: number
}

export const NOTHING: Written = { steps: [], writes: 0 }

/**
 * Where the Plan is held for a Turn: `write` is the `write_plan` handler's alone, and
 * `written` the loop's. `writes` counts the accepted writes, which is what lets the loop
 * tell which call of the model wrote.
 */
export type Plan = {
  readonly written: Effect.Effect<Written>
  readonly write: (steps: ReadonlyArray<Step>) => Effect.Effect<void>
}

// A Reference with a default, so reading it moves no handler's requirements, and a write
// run outside a Turn — a tool harness — records into nothing rather than failing: no Turn
// is around it, and none is the honest answer.
export const Plan: Context.Reference<Plan> = Context.Reference<Plan>(
  // Stryker disable next-line StringLiteral: the key only names the reference in a
  // context, and nothing else in the package claims a name it could collide with.
  'agent/tools/Plan',
  { defaultValue: () => ({ write: () => Effect.void, written: Effect.succeed(NOTHING) }) },
)

/** A fresh holder for one Turn: nothing written yet, and no write recorded. */
export const fresh: Effect.Effect<Plan> = Effect.gen(function* () {
  const written = yield* Ref.make(NOTHING)

  return {
    write: (steps) => Ref.update(written, (current) => ({ steps, writes: current.writes + 1 })),
    written: Ref.get(written),
  }
})

// How a Step reads in the Reminder's words: the same mark the screen shows it behind,
// because the message is the Plan said back to the model.
const marks = {
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]',
} satisfies { readonly [Status in Step['status']]: string }

/**
 * The Reminder's message: the Plan as it stands, said to the model by the harness rather
 * than the person, with every Step and its status, and what to do if the Plan no longer
 * matches the work. The words are pinned by a test; changing them is a deliberate act.
 */
export const reminder = (steps: ReadonlyArray<Step>): string =>
  [
    'Reminder from the harness: your Plan still has unfinished Steps. This is the Plan as you last wrote it:',
    ...steps.map((step) => `${marks[step.status]} ${step.text}`),
    'If the Plan no longer matches the work, write it again with write_plan.',
  ].join('\n')
