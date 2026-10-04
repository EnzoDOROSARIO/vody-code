import { NodeServices } from '@effect/platform-node'
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Ref, Stream } from 'effect'
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

import { Chat, LanguageModel, Prompt } from 'effect/ai'

import type { Path, PlatformError } from 'effect'
import type { AiError, Response } from 'effect/ai'
import type { ChildProcessSpawner } from 'effect/process'

const execFileP = promisify(execFile)

import { allowing } from './judging.ts'
import { answer } from '#turn.ts'
import { Catalog } from '#catalog.ts'
import { Home } from '#home.ts'
import { Session, handlers } from '#index.ts'
import { before } from '#tools/hooks.ts'
import { Hooks, toolkit, toolkitLayer } from '#tools/index.ts'
import * as LoadSkill from '#tools/load-skill.ts'
import * as WritePlan from '#tools/write-plan.ts'
import { Workspace } from '#workspace.ts'

import type { Activity } from '#activity.ts'
import type { Skill, SkillUnreadable } from '#catalog.ts'
import type { InstructionsUnreadable } from '#prompt.ts'
import type { Judge } from '#judge.ts'
import type { Handler } from '#tools/hooks.ts'
import type { Handlers, Tools } from '#tools/index.ts'

// The in-memory Catalog the unit tests run against: no Skills, and no disk read. The
// real reading is the startup suite's business; these tests are in memory, so they
// provide this and never touch the workspace's `.agents/skills/`.
const withoutSkills: Catalog['Service'] = new Map()

// `tools` on the platform, with `workspace` as the Workspace and `home` as the Home.
const mounted = (
  tools: Layer.Layer<
    Handlers,
    never,
    | Catalog
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
    | Home
    | Path.Path
    | Workspace
  >,
  workspace: string,
  home: Option.Option<string> = Option.none(),
): Layer.Layer<NodeServices.NodeServices | Catalog | Handlers | Workspace> =>
  tools.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(Workspace, workspace)),
    Layer.provide(Layer.succeed(Home, home)),
    Layer.provideMerge(Layer.succeed(Catalog, withoutSkills)),
  )

/**
 * The home directory a configuration names, through the port's own layer: a test keeps
 * its case in terms of HOME, and the port's answer — never HOME itself — is what the
 * Gate is handed.
 */
export const homeFrom = (
  env: Readonly<Record<string, string>>,
): Effect.Effect<Option.Option<string>> =>
  Home.pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
    Effect.provide(
      Home.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      ),
    ),
  )

/**
 * The agent's own gated handlers, the very layer it mounts, with `judge` as the Judge
 * its Gates consult. The Judge is the one thing substituted, and it is the real Judge,
 * budget and retry and all, over a scripted decision model: see `judging`.
 */
export const judged = (
  workspace: string,
  judge: Layer.Layer<Judge>,
  home: Option.Option<string> = Option.none(),
): Layer.Layer<NodeServices.NodeServices | Catalog | Handlers | Workspace> =>
  mounted(handlers.pipe(Layer.provide(judge)), workspace, home)

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
  home: Option.Option<string> = Option.none(),
): Layer.Layer<NodeServices.NodeServices | Catalog | Handlers | Workspace> =>
  hooks === undefined
    ? judged(workspace, allowing, home)
    : mounted(toolkitLayer.pipe(Layer.provide(Layer.succeed(Hooks, hooks))), workspace, home)

// The toolkit with nothing provided at the seam, so what the tools run through is the
// reference's own default. The agent never builds this — `handlers` always puts the Gate
// there — so the one test that shows what the empty seam does is the only way to it.
export const unhooked = (
  workspace: string,
): Layer.Layer<NodeServices.NodeServices | Catalog | Handlers | Workspace> =>
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

// A Skill folder kept elsewhere and linked into the skills directory: the link is what
// the catalog finds, and reading through it reaches the folder it names.
export const symlink = (target: string, link: string): Promise<void> =>
  Fs.mkdir(NodePath.dirname(link), { recursive: true }).then(() => Fs.symlink(target, link))

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
 * of the turn number: turn 0 is the answer to the first Request, turn 1 to whatever
 * follows it, and so on. A turn whose parts carry no `tool-call` ends that Request's
 * Turn; one with a `tool-call` sends the loop round again, to the next turn.
 *
 * The assembled prompt that call was sent comes with it — the history so far, with
 * whatever the loop added for this call after it — so a script that wants to see what
 * the loop said to the model reads it there; one that does not can take the turn alone.
 */
export type Script = (turn: number, prompt: Prompt.Prompt) => Array<Response.StreamPartEncoded>

// The highest seam in the package: the model itself, replaced by a script. Nothing
// below it is substituted, so the tools run for real against the workspace.
const scriptedLanguageModel = (
  streamText: (
    turn: number,
    prompt: Prompt.Prompt,
  ) => Stream.Stream<Response.StreamPartEncoded, AiError.AiError>,
): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    Effect.gen(function* () {
      const turns = yield* Ref.make(0)

      return yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: (options) =>
          Stream.unwrap(
            Effect.map(
              Ref.getAndUpdate(turns, (turn) => turn + 1),
              (turn) => streamText(turn, options.prompt),
            ),
          ),
      })
    }),
  )

export const scriptedModel = (script: Script): Layer.Layer<LanguageModel.LanguageModel> =>
  scriptedLanguageModel((turn, prompt) => Stream.fromIterable(script(turn, prompt)))

/**
 * The scripted model with the call on one turn broken: the call itself fails the way a
 * provider does, rather than streaming parts — a network drop, a rate limit, a sign-in
 * gone stale. `broken` numbers the calls from none, the same numbering the script's
 * turns use, so the turns after the broken one carry on with the script. Nothing below
 * the model is substituted, so the tools still run for real against the workspace.
 */
export const brokenModel = (
  script: Script,
  broken: number,
  failure: AiError.AiError,
): Layer.Layer<LanguageModel.LanguageModel> =>
  scriptedLanguageModel((turn, prompt) =>
    turn === broken ? Stream.fail(failure) : Stream.fromIterable(script(turn, prompt)),
  )

// The tools' answers from cans: every tool that touches the machine states a success as
// one string, so a can is a string, and what one tool's answer says against another's is
// nothing the loop can see. `write_plan` touches nothing, so it needs no can: its real
// handler runs, storing into whatever holder of the Plan is around the call. `load_skill`
// is the same: its real handler serves the in-memory Catalog the harness provides. A test
// that wants an act refused, or a tool to fail on its own, plays that in the hooks a can
// runs behind — the seam takes the failure as the tool's own, whether it stood in for one
// of the Gates or nothing at all.
const canned = toolkit.of({
  bash: () => Effect.succeed('exit 0\nhi'),
  edit_file: () => Effect.succeed('the file is the way the edit left it'),
  glob: () => Effect.succeed('kept.txt'),
  load_skill: LoadSkill.handler,
  read_file: () => Effect.succeed('kept'),
  write_file: () => Effect.succeed('wrote 4 bytes'),
  write_plan: WritePlan.handler,
})

/**
 * The tools answering from cans, the model the one given — `scriptedModel` for a script,
 * `brokenModel` for a call that breaks — and nothing of the machine behind anything: no
 * file read or written, no git walked, no command run. The one entry point a test has
 * into the agent with no infrastructure under it, so everything the loop does is said by
 * the model's script and answered by the cans — and the code it covers can live under
 * the unit gate's mutation run. `catalog` is the in-memory Catalog `load_skill` serves,
 * no Skills unless a test says otherwise, so a load never touches the workspace's own.
 */
export const rehearsed = (
  model: Layer.Layer<LanguageModel.LanguageModel>,
  requests: ReadonlyArray<string>,
  hooks: Hooks = {},
  answers: Partial<{ readonly [Name in keyof Tools]: Handler<Name> }> = {},
  catalog: ReadonlyMap<string, Skill> = withoutSkills,
): Effect.Effect<Array<Activity>> => {
  const program = Effect.gen(function* () {
    const kit = yield* toolkit
    const conversation = yield* Chat.fromPrompt(Prompt.empty)

    const seen: Array<Activity> = []

    for (const request of requests) {
      yield* Stream.runForEach(answer(conversation, kit, request), (activity) =>
        Effect.sync(() => seen.push(activity)),
      )
    }

    return seen
  })

  return program.pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
    Effect.provide(
      Layer.mergeAll(
        model,
        toolkit
          .toLayer(
            toolkit.of({
              bash: before(hooks, 'bash', answers.bash ?? canned.bash),
              edit_file: before(hooks, 'edit_file', answers.edit_file ?? canned.edit_file),
              glob: before(hooks, 'glob', answers.glob ?? canned.glob),
              load_skill: before(hooks, 'load_skill', answers.load_skill ?? canned.load_skill),
              read_file: before(hooks, 'read_file', answers.read_file ?? canned.read_file),
              write_file: before(hooks, 'write_file', answers.write_file ?? canned.write_file),
              write_plan: before(hooks, 'write_plan', answers.write_plan ?? canned.write_plan),
            }),
          )
          .pipe(Layer.provideMerge(Layer.succeed(Catalog, catalog))),
      ),
    ),
  )
}

/**
 * Put each Request to the agent's session, in one conversation, and collect every
 * Activity it reported along the way — through the callback the session hands them to,
 * the way a screen receives them. The model is the one given, so a test that wants the
 * Turn broken mid-way builds a `brokenModel`; the Workspace is whatever `tools`
 * provides, so the tools the script reaches for run against it, through whatever
 * `tools` puts at the seam.
 */
export const sessioned = (
  model: Layer.Layer<LanguageModel.LanguageModel>,
  requests: ReadonlyArray<string>,
  tools: Layer.Layer<NodeServices.NodeServices | Catalog | Handlers | Workspace>,
): Effect.Effect<
  Array<Activity>,
  InstructionsUnreadable | SkillUnreadable | PlatformError.PlatformError
> => {
  const program = Effect.gen(function* () {
    const agent = yield* Session

    const seen: Array<Activity> = []

    for (const request of requests) {
      yield* agent.ask(request, (activity) => {
        seen.push(activity)
      })
    }

    return seen
  })

  return program.pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
    Effect.provide(
      Session.layer.pipe(
        Layer.provideMerge(tools),
        Layer.provide(model),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  )
}

/**
 * Put each Request to the agent in turn, in one conversation, and collect every Activity
 * it reported along the way. The directory the tests were started in is the Workspace, so
 * the tools the script reaches for run against this repository, through whatever `hooks`
 * puts at the seam.
 */
export const asked = (
  script: Script,
  requests: ReadonlyArray<string>,
  hooks?: Hooks,
): Effect.Effect<
  Array<Activity>,
  InstructionsUnreadable | SkillUnreadable | PlatformError.PlatformError
> => sessioned(scriptedModel(script), requests, services(process.cwd(), hooks))
