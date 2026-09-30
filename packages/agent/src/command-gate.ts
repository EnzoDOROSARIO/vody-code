import { Effect, Option } from 'effect'

import { Judge } from './judge.ts'
import { Perimeter } from './perimeter.ts'
import { definition, policy } from './command-questions.ts'
import { Request } from './request.ts'
import { ActRefused, derive, explained, Verdict } from './verdict.ts'
import { Workspace } from './workspace.ts'

import type { Hook } from './tools/hooks.ts'

/**
 * The Gate in front of `bash`. Every command is put to the Judge, whole and exactly as
 * written, and runs only on the Verdict derived from its answers.
 *
 * Nothing stands in front of the Judge: no list of commands allowed or denied, and no
 * exemption for one that looks harmless, since a pattern cannot tell `rm -rf dist`
 * asked for from the same line not asked for. A compound command is not split, because
 * the rest of the line is what makes each part routine or not, and splitting it right
 * would take a shell parser (ADR 0001). Nothing is remembered either, so a command run
 * twice is judged twice.
 */
export const hook: Effect.Effect<Hook<'bash'>, never, Judge | Perimeter> = Effect.gen(function* () {
  const judge = yield* Judge
  const perimeter = yield* Perimeter

  const workspace = yield* Workspace

  // Stryker disable next-line StringLiteral: the name only labels the span, which nothing
  // in the package reads.
  return Effect.fn('CommandGate.examine')(function* ({ params: { command } }) {
    const request = yield* Request

    const answers = yield* judge.judge(definition, {
      command,
      workspace,
      perimeter: Option.getOrNull(perimeter.root),
      request: Option.getOrNull(request),
    })

    return yield* Verdict.$match(derive(policy, answers), {
      Allowed: () => Effect.void,
      Refused: ({ tripped }) =>
        Effect.fail(
          new ActRefused({
            tripped,
            reason: `bash will not run \`${command}\`: the Judge's answers refuse it (${explained(tripped)}). The refusal is final, so do not run the same command again: do the work another way, or tell the person what you meant to run and why`,
          }),
        ),
    })
  })
})
