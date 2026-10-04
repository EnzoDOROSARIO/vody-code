import { Effect, Schema } from 'effect'

import { Tool, Toolkit } from 'effect/unstable/ai'

import { Plan, Steps } from './plan.ts'

import type { Handler } from './hooks.ts'

const writePlan = Tool.make('write_plan', {
  description: [
    'Write your Plan for the work in hand: `steps` in order, each with the text of the work and',
    'a status — pending, in_progress, or completed. Write it when the work takes several Steps,',
    'not for a single action, and write it again as the work goes: mark a Step in_progress',
    'before you start it, completed as soon as it is done, and leave out a Step you dropped,',
    'because completed means the work was done. Each write replaces the whole Plan, and writing',
    'no Steps clears it. At most one Step may be in_progress at a time, a Step whose text is',
    'empty or whitespace only is refused, and a Plan holds at most 20 Steps.',
  ].join(' '),
  parameters: Schema.Struct({ steps: Steps }),
  success: Schema.String,
  // As every tool does: a parameter the schema refuses comes back to the model as this
  // tool's own failure, and the Turn carries on.
  // Stryker disable next-line StringLiteral: the toolkit tells "error" from every other
  // mode and nothing else, so no test can tell "return" from a mode that is not "error";
  // the rule refusals in plan.test.ts pin the returning itself.
  failureMode: 'return',
})

export const toolkit: Toolkit.Toolkit<{ readonly write_plan: typeof writePlan }> =
  Toolkit.make(writePlan)

/**
 * The real handler: it touches nothing on the machine, so it needs no can and no Gate —
 * it stores the Steps in the Turn's Plan and acknowledges briefly, with no echo of them.
 */
export const handler: Handler<'write_plan'> = ({ steps }) =>
  Effect.gen(function* () {
    const plan = yield* Plan

    yield* plan.write(steps)

    return 'Plan written'
  })
