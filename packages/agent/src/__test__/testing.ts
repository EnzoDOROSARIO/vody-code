import { BunServices } from '@effect/platform-bun'
import { Effect, FileSystem, Layer, Ref, Stream } from 'effect'
import { Chat, LanguageModel, Prompt } from 'effect/unstable/ai'
import type { Response } from 'effect/unstable/ai'

import { answer } from '#index.ts'
import { Hooks, toolkit, toolkitLayer } from '#tools/index.ts'
import { Workspace } from '#workspace.ts'

import type { Activity } from '#activity.ts'
import type { Handlers } from '#tools/index.ts'

// Hooks are read where the toolkit layer is built, so they go in under it. A test that
// passes none gets the reference's own default, the way the agent does: nothing is
// provided at the seam, so what every unhooked test runs through is that default.
export const services = (
  workspace: string,
  hooks?: Hooks,
): Layer.Layer<BunServices.BunServices | Handlers> =>
  toolkitLayer.pipe(
    Layer.provide(hooks === undefined ? Layer.empty : Layer.succeed(Hooks, hooks)),
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(Layer.succeed(Workspace, workspace)),
  )

export const onDisk = <A>(effect: Effect.Effect<A, never, FileSystem.FileSystem>): Promise<A> =>
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

// Every directory handed out, so a test can ask for one without also owning its
// removal. They outlive the test that made them by exactly as long as it takes the
// next `removeWorkspaces` to run.
const bases: Array<string> = []

/** A directory of a test's own, gone again at the next `removeWorkspaces`. */
export const temporary: Effect.Effect<string, never, FileSystem.FileSystem> = Effect.gen(
  function* () {
    const fs = yield* FileSystem.FileSystem

    const base = yield* fs.makeTempDirectory({ prefix: 'vody-' }).pipe(Effect.orDie)

    bases.push(base)

    return base
  },
)

export const removeWorkspaces = (): Promise<void> =>
  onDisk(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      for (const base of bases.splice(0)) {
        yield* fs.remove(base, { recursive: true, force: true }).pipe(Effect.orDie)
      }
    }),
  )

/**
 * What the language model streams back on each turn of a conversation, as a function
 * of the turn number: turn 0 is the answer to the first question, turn 1 to whatever
 * follows it, and so on. A turn whose parts carry no `tool-call` ends the question; one
 * with a `tool-call` sends the loop round again, to the next turn.
 */
export type Script = (turn: number) => Array<Response.StreamPartEncoded>

// The highest seam in the package: the model itself, replaced by a script. Nothing
// below it is substituted, so the tools run for real against the workspace.
export const scriptedModel = (script: Script): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const turns = yield* Ref.make(0)

      return yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () =>
          Stream.unwrap(
            Effect.map(
              Ref.getAndUpdate(turns, (turn) => turn + 1),
              (turn) => Stream.fromIterable(script(turn)),
            ),
          ),
      })
    }),
  )

/**
 * Put each question to the agent in turn, in one conversation, and collect every
 * Activity it reported along the way. The directory the tests were started in is the
 * Workspace, so the tools the script reaches for run against this repository.
 */
export const asked = (
  script: Script,
  questions: ReadonlyArray<string>,
): Promise<Array<Activity>> => {
  const program = Effect.gen(function* () {
    const tools = yield* toolkit
    const session = yield* Chat.fromPrompt(Prompt.empty)

    const seen: Array<Activity> = []

    for (const question of questions) {
      yield* Stream.runForEach(answer(session, tools, question), (activity) =>
        Effect.sync(() => {
          seen.push(activity)
        }),
      )
    }

    return seen
  })

  return Effect.runPromise(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
    program.pipe(Effect.provide(Layer.mergeAll(scriptedModel(script), services(process.cwd())))),
  )
}
