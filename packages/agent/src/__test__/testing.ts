import { NodeServices } from '@effect/platform-node'
import { Effect, Exit, FileSystem, Layer, Ref, Stream } from 'effect'
// The one `git init` the suite launches, once per test process; see `initialised`.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- a process, run once, outside every effect
import { execFile } from 'node:child_process'
// The probes below sit outside the effects a test runs, as plain promises: what
// `Bun.file` and `Bun.write` did for bun:test.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- plain node promises, not Effects
import * as Fs from 'node:fs/promises'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- builds the fixture paths those probes take
import * as NodePath from 'node:path'
import { promisify } from 'node:util'
import * as Util from 'node:util'

import { Chat, LanguageModel, Prompt } from 'effect/unstable/ai'

import type { Path } from 'effect'
import type { AiError, Response } from 'effect/unstable/ai'
import type { ChildProcessSpawner } from 'effect/unstable/process'

const execFileP = promisify(execFile)

import { allowing } from './judging.ts'
import { answer, handlers } from '#index.ts'
import { Hooks, toolkit, toolkitLayer } from '#tools/index.ts'
import { Workspace } from '#workspace.ts'

import type { Activity } from '#activity.ts'
import type { Judge } from '#judge.ts'
import type { Handlers } from '#tools/index.ts'

// `tools` on the platform, with `workspace` as the Workspace.
const mounted = (
  tools: Layer.Layer<
    Handlers,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  >,
  workspace: string,
): Layer.Layer<NodeServices.NodeServices | Handlers> =>
  tools.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(Workspace, workspace)),
  )

/**
 * The agent's own gated handlers, the very layer it mounts, with `judge` as the Judge
 * its Gates consult. The Judge is the one thing substituted, and it is the real Judge,
 * budget and retry and all, over a scripted decision model: see `judging`.
 */
export const judged = (
  workspace: string,
  judge: Layer.Layer<Judge>,
): Layer.Layer<NodeServices.NodeServices | Handlers> =>
  mounted(handlers.pipe(Layer.provide(judge)), workspace)

// Hooks are read where the toolkit layer is built, so they go in under it. A test that
// passes none gets `handlers`, the very layer the agent mounts, so every test entry point
// in the package runs through the Gates the agent runs, and an agent that stopped running
// one would fail that Gate's tests; a test that passes its own hooks takes the seam over.
// The Judge behind those Gates finds everything it is asked about requested and harmless,
// so a test that does not care what is judged sees a write outside, or any shell command,
// go ahead, and none of them reaches the network.
export const services = (
  workspace: string,
  hooks?: Hooks,
): Layer.Layer<NodeServices.NodeServices | Handlers> =>
  hooks === undefined
    ? judged(workspace, allowing)
    : mounted(toolkitLayer.pipe(Layer.provide(Layer.succeed(Hooks, hooks))), workspace)

// The toolkit with nothing provided at the seam, so what the tools run through is the
// reference's own default. The agent never builds this — `handlers` always puts the Gate
// there — so the one test that shows what the empty seam does is the only way to it.
export const unhooked = (workspace: string): Layer.Layer<NodeServices.NodeServices | Handlers> =>
  mounted(toolkitLayer, workspace)

export const onDisk = <A>(effect: Effect.Effect<A, never, FileSystem.FileSystem>): Promise<A> =>
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

// Filesystem probes over plain node promises, for assertions and fixtures that sit
// outside the effects a test runs: what `Bun.file` and `Bun.write` did for bun:test.
// `write` reproduces `Bun.write`'s habit of creating the directories along the way.
export const fileExists = (path: string): Promise<boolean> =>
  Fs.stat(path).then(
    () => true,
    () => false,
  )

export const readText = (path: string): Promise<string> => Fs.readFile(path, 'utf8')

// The bytes of a file, as numbers a `toEqual` can compare byte for byte: how a test
// looks past text decoding, at exactly what a write left on disk.
export const bytesOf = (path: string): Promise<Array<number>> =>
  Fs.readFile(path).then((bytes) => Array.from(bytes))

export const fileSize = (path: string): Promise<number> => Fs.stat(path).then((info) => info.size)

export const entriesOf = (path: string): Promise<Array<string>> => Fs.readdir(path)

export const removeTree = (path: string): Promise<void> =>
  Fs.rm(path, { recursive: true, force: true })

export const write = (path: string, content: string | Uint8Array): Promise<void> =>
  Fs.mkdir(NodePath.dirname(path), { recursive: true }).then(() => Fs.writeFile(path, content))

// What a program's outcome looks like when it is printed rather than inspected:
// a failure renders as its Cause with the errors' fields expanded, so a test can
// assert on the words the failure carries. What `Bun.inspect(exit)` did for
// bun:test, message included.
export const rendered = (exit: Exit.Exit<unknown, unknown>): string =>
  Exit.isFailure(exit) ? Util.inspect(exit.cause, { depth: 6 }) : 'the program succeeded'

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

// The repository every workspace starts as: the `.git` of one `git init`, held as the
// directories and files it is made of. Launching git for each test is what made the
// suite slow — under mutation testing, parallel runs launching hundreds of processes
// starved one another past the timeout — so it runs once per test process, on first
// use, and each workspace is written from the copy in memory. In memory rather than on
// disk, so there is no template directory left to outlive the process.
type Repository = {
  readonly directories: ReadonlyArray<string>
  readonly files: ReadonlyArray<readonly [string, Uint8Array]>
}

const initialised: Effect.Effect<Repository, never, FileSystem.FileSystem> = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: 'vody-template-' })

    yield* fs.makeDirectory(`${scratch}/template`)

    // An empty template leaves out git's sample hooks and descriptions, which nothing
    // here reads. The branch name is passed to this one command rather than read from
    // the developer's configuration, so the repository looks the same on every machine.
    yield* Effect.promise(() =>
      execFileP(
        'git',
        ['-c', 'init.defaultBranch=main', 'init', '-q', `--template=${scratch}/template`, 'repo'],
        { cwd: scratch },
      ),
    )

    const metadata = `${scratch}/repo/.git`

    const directories: Array<string> = []
    const files: Array<readonly [string, Uint8Array]> = []

    for (const entry of yield* fs.readDirectory(metadata, { recursive: true })) {
      const info = yield* fs.stat(`${metadata}/${entry}`)

      if (info.type === 'Directory') {
        directories.push(entry)
      } else {
        files.push([entry, yield* fs.readFile(`${metadata}/${entry}`)])
      }
    }

    return { directories, files }
  }),
).pipe(Effect.orDie)

const repository: Effect.Effect<Repository, never, FileSystem.FileSystem> = Effect.runSync(
  Effect.cached(initialised),
)

// A workspace with a file to find inside it and one outside, so a test can show
// that a tool reaches past the root the way bash would. The workspace is a git
// repository, because a Perimeter is a working tree and a plain directory has none;
// the file outside it is outside the repository too, and so outside any Perimeter.
//
// What comes back is the real path. On macOS the temporary directory sits behind a
// symbolic link, and the Perimeter resolves the Workspace to its real path before it
// walks up looking for `.git`, so a test that compares against the root it finds would
// otherwise have to resolve the link itself.
export const workspace: Effect.Effect<string> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  const base = yield* temporary

  yield* fs.makeDirectory(`${base}/work/inside`, { recursive: true })
  yield* fs.makeDirectory(`${base}/outside`, { recursive: true })
  yield* fs.writeFile(`${base}/work/inside/keep.txt`, new TextEncoder().encode('kept'))
  yield* fs.writeFile(`${base}/outside/secret.txt`, new TextEncoder().encode('secret'))

  const { directories, files } = yield* repository

  for (const directory of directories) {
    yield* fs.makeDirectory(`${base}/work/.git/${directory}`, { recursive: true })
  }

  for (const [file, content] of files) {
    yield* fs.writeFile(`${base}/work/.git/${file}`, content)
  }

  return yield* fs.realPath(`${base}/work`)
}).pipe(
  Effect.orDie,
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
  Effect.provide(NodeServices.layer),
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
 * Put each question to the agent in turn, in one conversation, over `tools`, and collect
 * every Activity it reported along the way. `asked` is this over the default services;
 * a test that needs a Perimeter to be outside of, or a Judge that refuses, builds its own
 * with `judged` and comes here directly.
 */
export const conversed = (
  script: Script,
  questions: ReadonlyArray<string>,
  tools: Layer.Layer<NodeServices.NodeServices | Handlers>,
): Effect.Effect<Array<Activity>, AiError.AiError> => {
  const program = Effect.gen(function* () {
    const kit = yield* toolkit
    const session = yield* Chat.fromPrompt(Prompt.empty)

    const seen: Array<Activity> = []

    for (const question of questions) {
      yield* Stream.runForEach(answer(session, kit, question), (activity) =>
        Effect.sync(() => {
          seen.push(activity)
        }),
      )
    }

    return seen
  })

  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
  return program.pipe(Effect.provide(Layer.mergeAll(scriptedModel(script), tools)))
}

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
): Effect.Effect<Array<Activity>, AiError.AiError> =>
  conversed(script, questions, services(process.cwd(), hooks))
