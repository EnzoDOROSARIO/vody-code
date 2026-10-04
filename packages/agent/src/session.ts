import { Context, Effect, Layer, Stream } from 'effect'

import type { FileSystem, Path, PlatformError } from 'effect'
import type { LanguageModel } from 'effect/ai'

import type { Activity } from './activity.ts'
import { chat } from './prompt.ts'
import { answer } from './turn.ts'
import { toolkit } from './tools/index.ts'

import type { Catalog, SkillUnreadable } from './catalog.ts'
import type { Handlers } from './tools/index.ts'
import type { InstructionsUnreadable } from './prompt.ts'
import type { Workspace } from './workspace.ts'

/**
 * The one service the screen composes. It owns a Turn end to end: the conversation is
 * built when the session is, from what the Workspace has to say for itself, and the
 * handlers the Turn reaches for are the gated ones the agent mounts. One `ask` runs the
 * whole Turn, handing each Activity to the callback the screen provides as it happens,
 * so the screen composes nothing but this service, and never touches the language
 * model, the tool handlers, or the framework's types.
 *
 * The ask is total: the loop reports a Turn the model broke as its own Activity — the
 * Breakdown, beside the Impasse — so nothing escapes as an error, and the transcript
 * always has the Turn's ending said to it.
 */
// Stryker disable StringLiteral: the key only names the service in a context, and
// nothing else in the package claims a name it could collide with.
export class Session extends Context.Service<
  Session,
  {
    /**
     * Run one Turn on what `request` says, handing every Activity the loop reports to
     * `show` as it happens, and finishing once the Turn is over — with an answer, at an
     * Impasse, or at a Breakdown. Nothing fails: whatever the model broke is already
     * the Turn's last Activity.
     */
    readonly ask: (request: string, show: (activity: Activity) => void) => Effect.Effect<void>
  }
>()('agent/Session') {
  // Stryker restore StringLiteral

  /**
   * The session the agent runs. The workspace's instructions and its Catalog of Skills
   * are read while the layer is built, before any screen exists, so a file that cannot be
   * read is reported to a terminal that still belongs to the shell. The handlers and the
   * language model stay open, for the agent's layer to give them the real ones and the
   * tests a scripted one.
   */
  static readonly layer: Layer.Layer<
    Session,
    InstructionsUnreadable | SkillUnreadable | PlatformError.PlatformError,
    Catalog | Handlers | LanguageModel.LanguageModel | FileSystem.FileSystem | Path.Path | Workspace
  > = Layer.effect(
    Session,
    Effect.gen(function* () {
      const conversation = yield* chat

      const tools = yield* toolkit

      // A Turn runs to a promise outside any fiber of this runtime, so the services it
      // needs go with it: captured here, where the session is built, and provided again
      // around every ask.
      const services = yield* Effect.context<Handlers | LanguageModel.LanguageModel>()

      const ask = (request: string, show: (activity: Activity) => void): Effect.Effect<void> =>
        Stream.runForEach(answer(conversation, tools, request), (activity) =>
          Effect.sync(() => show(activity)),
        ).pipe(Effect.provide(services))

      return Session.of({ ask })
    }),
  )
}
