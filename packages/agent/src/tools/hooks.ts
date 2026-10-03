import { Context, Effect, Ref, Stream } from 'effect'

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

/** At most one hook per tool. A tool with none runs unexamined — written as `undefined`
 * where a record names every tool, since `exactOptionalPropertyTypes` tells a missing
 * key from one that says there is none. */
export type Hooks = { readonly [Name in keyof Tools]?: Hook<Name> | undefined }

// The seam every tool runs through, with nothing in it. This is mechanism only: what
// occupies it is provided where the toolkit layer is built, and nothing has to be.
// Stryker disable next-line StringLiteral: the key only names the reference in a context,
// and nothing else in the package claims a name it could collide with.
export const Hooks: Context.Reference<Hooks> = Context.Reference<Hooks>('agent/tools/Hooks', {
  defaultValue: () => ({}),
})

/**
 * What one call of the model got through the Gates. The seam is the only writer: an act
 * is recorded after a hook has let it past and the tool has then succeeded, which is the
 * whole of what "a gated act that was allowed" means. The loop is the only reader, and it
 * reads once, after the call's stream has ended.
 */
export type Passage = {
  /** Record one act that got through the Gate in front of it. Never fails. */
  readonly record: Effect.Effect<void>
}

// A Reference with a default, so reading it moves no handler's requirements, and an act
// run outside a call of the model — the harness, a Gate's own tests — records into
// nothing rather than failing: no call is around it, and none is the honest answer.
export const Passage: Context.Reference<Passage> = Context.Reference<Passage>(
  // Stryker disable next-line StringLiteral: the key only names the reference in a
  // context, and nothing else in the package claims a name it could collide with.
  'agent/tools/Passage',
  { defaultValue: () => ({ record: Effect.void }) },
)

/**
 * `stream` with one call of the model's Passage around it: every act the hooks in front
 * of the stream's tools let through while it runs is recorded here, and `passed` answers
 * whether any did. Making the Passage here, one per call, is what keeps a call's act from
 * clearing the count of the call after it; `passed` is read after the stream has ended,
 * and never before.
 */
export const watched = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
): Effect.Effect<{
  readonly passed: Effect.Effect<boolean>
  readonly stream: Stream.Stream<A, E, R>
}> =>
  Effect.map(Ref.make(false), (through) => ({
    passed: Ref.get(through),
    stream: stream.pipe(Stream.provideService(Passage, { record: Ref.set(through, true) })),
  }))

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
 *
 * A passage is recorded only when both happen, in this order: the hook passes and the
 * tool then succeeds. A hook that passed while the tool failed on its own — an edit
 * that matched nothing — did nothing, and is not recorded; a tool with no hook is never
 * recorded, because nothing stood in front of it to let it through.
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
        Effect.gen(function* () {
          const passage = yield* Passage

          yield* hook({ name, params })

          const result = yield* handler(params, context)

          yield* passage.record

          return result
        })
}
