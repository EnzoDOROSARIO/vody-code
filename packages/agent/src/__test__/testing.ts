import { BunServices } from '@effect/platform-bun'
import { Effect, FileSystem, Layer, Ref, Stream } from 'effect'
import { Chat, LanguageModel, Prompt } from 'effect/unstable/ai'
import type { Path } from 'effect'
import type { Response } from 'effect/unstable/ai'
import type { ChildProcessSpawner } from 'effect/unstable/process'

import { answer, handlers } from '#index.ts'
import { Hooks, toolkit, toolkitLayer } from '#tools/index.ts'
import { Workspace } from '#workspace.ts'

import type { Activity } from '#activity.ts'
import type { Handlers } from '#tools/index.ts'

// `tools` on the platform, with `workspace` as the Workspace.
const mounted = (
  tools: Layer.Layer<
    Handlers,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >,
  workspace: string,
): Layer.Layer<BunServices.BunServices | Handlers> =>
  tools.pipe(
    Layer.provideMerge(BunServices.layer),
    Layer.provideMerge(Layer.succeed(Workspace, workspace)),
  )

// Hooks are read where the toolkit layer is built, so they go in under it. A test that
// passes none gets `handlers`, the very layer the agent mounts, so every test entry point
// in the package runs through the Gate the agent runs, and an agent that stopped running
// it would fail the Gate's tests; a test that passes its own hooks takes the seam over.
export const services = (
  workspace: string,
  hooks?: Hooks,
): Layer.Layer<BunServices.BunServices | Handlers> =>
  mounted(
    hooks === undefined ? handlers : toolkitLayer.pipe(Layer.provide(Layer.succeed(Hooks, hooks))),
    workspace,
  )

// The toolkit with nothing provided at the seam, so what the tools run through is the
// reference's own default. The agent never builds this — `handlers` always puts the Gate
// there — so the one test that shows what the empty seam does is the only way to it.
export const unhooked = (workspace: string): Layer.Layer<BunServices.BunServices | Handlers> =>
  mounted(toolkitLayer, workspace)

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

// A workspace with a file to find inside it and one outside, so a test can show
// that a tool reaches past the root the way bash would. The workspace is a git
// repository, because a Perimeter is a working tree and a plain directory has none;
// the file outside it is outside the repository too, and so outside any Perimeter.
//
// What comes back is the real path. On macOS the temporary directory sits behind a
// symbolic link, and git names the tree by where it really is, so a test that
// compares the two would otherwise have to resolve the link itself.
export const workspace = (): Promise<string> =>
  onDisk(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const base = yield* temporary

      yield* Effect.promise(() => Bun.write(`${base}/work/inside/keep.txt`, 'kept'))
      yield* Effect.promise(() => Bun.write(`${base}/outside/secret.txt`, 'secret'))

      // The branch name is passed to this one command rather than read from the
      // developer's configuration, so the repository looks the same on every machine.
      yield* Effect.promise(() =>
        Bun.$`git -c init.defaultBranch=main init -q`.cwd(`${base}/work`).quiet(),
      )

      return yield* fs.realPath(`${base}/work`).pipe(Effect.orDie)
    }),
  )

// The fixture directory beside the workspace, by its real path: `workspace` hands out
// the real path of `work`, and `outside` is its sibling, so this is where a write past
// the root really lands.
export const outside = (root: string): string => `${root.slice(0, root.lastIndexOf('/'))}/outside`

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
 * Workspace, so the tools the script reaches for run against this repository, through
 * whatever `hooks` puts at the seam.
 */
export const asked = (
  script: Script,
  questions: ReadonlyArray<string>,
  hooks?: Hooks,
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

  const provided = Layer.mergeAll(scriptedModel(script), services(process.cwd(), hooks))

  return Effect.runPromise(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
    program.pipe(Effect.provide(provided)),
  )
}
