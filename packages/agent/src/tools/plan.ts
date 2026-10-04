import { Context, Effect, Ref, Schema } from 'effect'

/** Where one Step of the Plan stands: the three states the agent can mark it with. */
const Status = Schema.Literals(['pending', 'in_progress', 'completed'])

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

// Stryker disable next-line ArrayDeclaration: nothing reads the initial Steps — a
// Reminder needs an armed loop, and only a write arms it, replacing these Steps whole —
// so no test can tell an empty start from any other.
const NOTHING: Written = { steps: [], writes: 0 }

/**
 * The Turn's holder of the Plan: `write` is the `write_plan` handler's alone, and it is
 * all that goes into context. The loop's reader comes from `fresh` instead, handed to
 * the loop directly, so nothing but the handler can reach the Plan to write it.
 */
export type PlanHolder = {
  readonly write: (steps: ReadonlyArray<Step>) => Effect.Effect<void>
}

// A Reference with a default, so reading it moves no handler's requirements, and a write
// run outside a Turn — a tool harness — records into nothing rather than failing: no Turn
// is around it, and none is the honest answer.
export const PlanHolder: Context.Reference<PlanHolder> = Context.Reference<PlanHolder>(
  // Stryker disable next-line StringLiteral: the key only names the reference in a
  // context, and nothing else in the package claims a name it could collide with.
  'agent/tools/PlanHolder',
  { defaultValue: () => ({ write: () => Effect.void }) },
)

/** A fresh holder for one Turn, and the reader beside it: nothing written yet, and no
 * write recorded. The reader belongs to the loop, which never has to read the holder
 * back out of context. */
export const fresh: Effect.Effect<{
  readonly holder: PlanHolder
  readonly written: Effect.Effect<Written>
}> = Effect.gen(function* () {
  const written = yield* Ref.make(NOTHING)

  return {
    holder: {
      write: (steps) => Ref.update(written, (current) => ({ steps, writes: current.writes + 1 })),
    },
    written: Ref.get(written),
  }
})
