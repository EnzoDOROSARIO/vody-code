import { Context, Effect } from 'effect'

import type { AiError, Tool, Toolkit } from 'effect/unstable/ai'

import type { Call, Tools } from './toolkit.ts'

/**
 * What runs before one tool does. Succeeding lets the call go ahead; failing stops it,
 * and the failure goes back to the model as that tool's own — so a hook can only stop
 * a tool with a failure the tool has declared, and there is no stop its failure
 * schema cannot encode.
 */
export type Hook<Name extends keyof Tools> = (
  call: Call<Name>,
) => Effect.Effect<void, Tool.Failure<Tools[Name]>>

/** At most one hook per tool. A tool with none runs unexamined. */
export type Hooks = { readonly [Name in keyof Tools]?: Hook<Name> }

// The seam every tool runs through, with nothing in it. This is mechanism only: what
// occupies it is provided where the toolkit layer is built, and nothing has to be.
// Stryker disable next-line StringLiteral: the key only names the reference in a context,
// and nothing else in the package claims a name it could collide with.
export const Hooks: Context.Reference<Hooks> = Context.Reference<Hooks>('agent/tools/Hooks', {
  defaultValue: () => ({}),
})

// The shape `Toolkit.HandlersFrom` gives one tool's handler, spelled out so a handler
// can be taken and given back under its tool's name.
export type Handler<Name extends keyof Tools> = (
  params: Tool.Parameters<Tools[Name]>,
  context: Toolkit.HandlerContext<Tools[Name]>,
) => Effect.Effect<
  Tool.Success<Tools[Name]>,
  Tool.Failure<Tools[Name]> | AiError.AiError | AiError.AiErrorReason,
  Tool.HandlerServices<Tools[Name]>
>

/**
 * The handler for `name`, with whatever hook `hooks` holds for it run first.
 *
 * The hook is handed the arguments the toolkit has already decoded, so it sees what
 * the tool is about to see. A hook that fails is the tool failing, before anything
 * the tool does has happened.
 */
export const before = <Name extends keyof Tools>(
  hooks: Hooks,
  name: Name,
  handler: Handler<Name>,
): Handler<Name> => {
  const hook = hooks[name]

  return hook === undefined
    ? handler
    : (params, context) =>
        hook({ name, params }).pipe(Effect.flatMap(() => handler(params, context)))
}
