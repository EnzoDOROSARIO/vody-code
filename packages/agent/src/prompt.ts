import { Effect, FileSystem, Option, Path, Predicate, Schema } from 'effect'

import type { PlatformError } from 'effect'
import { Chat, Prompt } from 'effect/unstable/ai'

import { Workspace } from '#workspace.ts'

// Best first. A workspace carrying both has renamed its instructions and kept the old
// name for another agent, so the two say the same thing — and a `CLAUDE.md` symlinked
// to `AGENTS.md` is one file under two names. Reading past the first would say it twice.
const CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const

// A file that is there and cannot be read stops the session. Starting anyway would
// mean an agent working without the rules the workspace wrote down, and neither the
// model nor whoever asked would know it.
export class InstructionsUnreadable extends Schema.TaggedError<InstructionsUnreadable>()(
  'InstructionsUnreadable',
  { path: Schema.String, reason: Schema.String },
) {
  // This is the one error in the package that reaches a terminal rather than the model,
  // and `BunRuntime.runMain` prints only `cause.message`. Without this the session
  // refuses to start and says nothing about which file, or what went wrong with it.
  override get message(): string {
    return `${this.path} could not be read: ${this.reason}`
  }
}

/** What a workspace has written down for whoever works in it. */
export type Instructions = {
  readonly path: string
  readonly text: string
}

const absent = (error: PlatformError.PlatformError): boolean =>
  Predicate.isTagged(error.reason, 'NotFound')

// Read rather than ask and then read: one syscall, no gap between the two for the file
// to change in, and a directory named `AGENTS.md` arrives as the failure it is.
const read = (
  file: string,
): Effect.Effect<Option.Option<Instructions>, InstructionsUnreadable, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => Option.some({ path: file, text })),
      Effect.catchIf(absent, () => Effect.succeed(Option.none<Instructions>())),
      Effect.mapError((error) => new InstructionsUnreadable({ path: file, reason: error.message })),
    ),
  )

// Only the workspace itself. Walking up to the repository root, or to the home
// directory, would pick up instructions written for somewhere else and leave the agent
// unable to say which of them it was following.
const projectInstructions: Effect.Effect<
  Option.Option<Instructions>,
  InstructionsUnreadable,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const path = yield* Path.Path

  const workspace = yield* Workspace

  for (const name of CANDIDATES) {
    const instructions = yield* read(path.join(workspace, name))

    if (Option.isSome(instructions)) {
      return instructions
    }
  }

  return Option.none()
})

// One array entry per line of the prompt. A template literal spanning these four lines
// would carry the source indentation into the string — which it did, leaving the model
// three of the lines indented by three or four spaces against a first line at column 0.
const standing = (workspace: string): string =>
  [
    'You are an expert coding assistant operating inside Vody Code, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.',
    'Be concise in your responses.',
    'Show file paths clearly when working with files',
    `You are operating in ${workspace}`,
  ].join('\n')

// The workspace speaks in its own words, under a tag naming the file they came from:
// the model can go and read the rest of it, or be asked to change it.
const quoted = ({ path, text }: Instructions): string =>
  `<project_instructions path="${path}">\n${text}\n</project_instructions>`

const systemPrompt = (workspace: string, instructions: Option.Option<Instructions>): string =>
  Option.match(instructions, {
    onNone: () => standing(workspace),
    onSome: (found) => [standing(workspace), quoted(found)].join('\n\n'),
  })

export const chat: Effect.Effect<
  Chat.Chat,
  InstructionsUnreadable,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const workspace = yield* Workspace

  const instructions = yield* projectInstructions

  return yield* Chat.fromPrompt(
    Prompt.empty.pipe(Prompt.setSystem(systemPrompt(workspace, instructions))),
  )
})
