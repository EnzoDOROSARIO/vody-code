import { Effect, Schema } from 'effect'

import { Tool, Toolkit } from 'effect/ai'

import { Catalog, byName } from '#catalog.ts'

import type { Skill } from '#catalog.ts'
import type { Handler } from './hooks.ts'

/**
 * An unknown name is `load_skill`'s own failure: it goes back to the model as the tool's
 * answer, listing the names that do exist so the next call can be right.
 */
export class SkillNotFound extends Schema.TaggedError<SkillNotFound>()('SkillNotFound', {
  name: Schema.String,
  reason: Schema.String,
}) {}

// What the model is told when it asks for a name the Catalog does not hold: the name it
// used, and the names it could have used, sorted so the same Catalog gives the same
// correction. An empty Catalog is said in its own words rather than as an empty list.
const unknown = (name: string, catalog: ReadonlyMap<string, Skill>): string => {
  const names = [...catalog.keys()].toSorted(byName)

  return names.length === 0
    ? `There is no Skill named "${name}": the Catalog holds no Skills`
    : `There is no Skill named "${name}". The Catalog holds: ${names.join(', ')}`
}

const loadSkill = Tool.make('load_skill', {
  description: [
    'Load a Skill from the Catalog: pass the `name` the Catalog listed it under, and the result',
    "is the Skill's instructions, under the absolute path of the folder holding it. To read any",
    'other file in that folder, when the instructions send you there, use read_file with that path.',
  ].join(' '),
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  failure: SkillNotFound,
  // As every tool does: a parameter the schema refuses comes back to the model as this
  // tool's own failure, and the Turn carries on.
  // Stryker disable next-line StringLiteral: the toolkit tells "error" from every other
  // mode and nothing else, so no test can tell "return" from a mode that is not "error";
  // the rule refusals in load-skill.test.ts pin the returning itself.
  failureMode: 'return',
})

export const toolkit: Toolkit.Toolkit<{ readonly load_skill: typeof loadSkill }> =
  Toolkit.make(loadSkill)

/**
 * The real handler, closed over the Catalog the toolkit layer was built with: it serves
 * the startup copy, so it touches nothing on the machine and the only way it can fail is
 * a name the Catalog does not know.
 */
export const serving = (catalog: ReadonlyMap<string, Skill>): Handler<'load_skill'> =>
  // Stryker disable next-line StringLiteral: the span name is for whoever traces a run; no
  // test reads spans, and the tool's own name already names the call.
  Effect.fn('load_skill')(function* ({ name }) {
    const skill = catalog.get(name)

    if (skill === undefined) {
      return yield* new SkillNotFound({ name, reason: unknown(name, catalog) })
    }

    return `<skill name="${name}" path="${skill.path}">\n${skill.body}\n</skill>`
  })

/**
 * The Catalog is read once, here, while the toolkit layer is built — never per call. The
 * handler closes over the copy, which is what puts `Catalog` in this effect's
 * requirements: a composition that forgets it is a compile error, not a load that finds
 * nothing at runtime.
 */
export const handlers: Effect.Effect<
  Toolkit.HandlersFrom<(typeof toolkit)['tools']>,
  never,
  Catalog
> = Effect.map(Catalog, (catalog) => toolkit.of({ load_skill: serving(catalog) }))
