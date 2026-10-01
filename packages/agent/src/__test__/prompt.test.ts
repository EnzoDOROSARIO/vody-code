import { afterEach, expect, it } from '@effect/vitest'
import { Effect, Ref } from 'effect'
import type { Chat } from 'effect/unstable/ai'

import { chat, InstructionsUnreadable } from '#prompt.ts'
import { onDisk, removeWorkspaces, services, temporary, write } from './testing.ts'

afterEach(removeWorkspaces)

// The standing instructions the model works under, pinned in full: they are joined
// with newlines rather than written as one template literal because a literal spanning
// those lines carried its own indentation into the prompt, and pinning the text keeps
// both that and any change to the instructions visible.
const standing = (workspace: string): string =>
  [
    'You are an expert coding assistant operating inside Vody Code, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.',
    'Be concise in your responses.',
    'Show file paths clearly when working with files',
    `You are operating in ${workspace}`,
  ].join('\n')

const instructions = (workspace: string): Effect.Effect<string, InstructionsUnreadable> =>
  Effect.flatMap(chat, (conversation) => Ref.get(conversation.history)).pipe(
    Effect.flatMap((history) => {
      const [system] = history.content

      if (system?.role !== 'system') {
        return Effect.die(
          new Error(`the conversation opens with ${String(system?.role)}, not a system message`),
        )
      }

      return Effect.succeed(system.content)
    }),
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
    Effect.provide(services(workspace)),
  )

const refusal = (workspace: string): Effect.Effect<InstructionsUnreadable, Chat.Chat> =>
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
  Effect.flip(chat).pipe(Effect.provide(services(workspace)))

it.live('the model is given the standing instructions, and told where it is working', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    expect(yield* instructions(workspace)).toBe(standing(workspace))
  }),
)

it.live('a workspace with an AGENTS.md speaks for itself, under the path it spoke from', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => write(`${workspace}/AGENTS.md`, '# House rules\n\nRun the tests.'))

    expect(yield* instructions(workspace)).toBe(
      [
        standing(workspace),
        `<project_instructions path="${workspace}/AGENTS.md">\n# House rules\n\nRun the tests.\n</project_instructions>`,
      ].join('\n\n'),
    )
  }),
)

it.live('a workspace that kept its instructions in CLAUDE.md is read just the same', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => write(`${workspace}/CLAUDE.md`, 'legacy rules'))

    expect(yield* instructions(workspace)).toContain(
      `<project_instructions path="${workspace}/CLAUDE.md">\nlegacy rules\n</project_instructions>`,
    )
  }),
)

// A workspace carrying both has renamed its instructions and kept the old name for
// another agent. Reading the second would say the same thing twice, so `AGENTS.md`
// answers for both and `CLAUDE.md` is never opened.
it.live('AGENTS.md answers for a workspace that carries CLAUDE.md as well', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => write(`${workspace}/AGENTS.md`, 'current rules'))
    yield* Effect.promise(() => write(`${workspace}/CLAUDE.md`, 'legacy rules'))

    const prompt = yield* instructions(workspace)

    expect(prompt).toContain('current rules')
    expect(prompt).not.toContain('legacy rules')
  }),
)

// Nothing above the workspace is read: instructions written for a directory the agent
// is not working in are instructions for someone else.
it.live('an AGENTS.md in the parent of the workspace is not the workspace speaking', () =>
  Effect.gen(function* () {
    const base = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => write(`${base}/AGENTS.md`, 'rules from upstairs'))
    yield* Effect.promise(() => write(`${base}/work/keep.txt`, 'kept'))

    expect(yield* instructions(`${base}/work`)).toBe(standing(`${base}/work`))
  }),
)

it.live('instructions that cannot be read stop the session rather than going unmentioned', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() =>
      write(`${workspace}/AGENTS.md/nested.txt`, 'AGENTS.md is a directory here'),
    )

    const stopped = yield* refusal(workspace)

    expect(stopped).toBeInstanceOf(InstructionsUnreadable)
    expect(stopped.path).toBe(`${workspace}/AGENTS.md`)
    // What the file system said, not a sentence of this module's own: the reason a read
    // failed is only useful if it is the one the platform gave. The platform's message
    // embeds the path as well, so the path alone would satisfy any wording; `module.method`
    // is Effect's own and comes from nowhere else in this codebase.
    expect(stopped.reason).not.toBe(stopped.path)
    expect(stopped.reason).toContain('FileSystem.readFile')
    // `NodeRuntime.runMain` prints the message and nothing else, so both fields have to
    // be in it or the refusal reaches the terminal with nothing to act on.
    expect(stopped.message).toContain(`${workspace}/AGENTS.md`)
    expect(stopped.message).toContain(stopped.reason)
  }),
)

// The tag is the whole of how a caller tells this failure from any other: `catchTag`
// matches the runtime `_tag` and nothing else, so a name that drifts from the one the
// type promises leaves the refusal impossible to recover from by the name it is exported
// under. The tui lets it reach `runMain` today; a caller that wants to ask for another
// workspace instead has only this to catch.
it.live('the refusal answers to the tag its type promises', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() =>
      write(`${workspace}/AGENTS.md/nested.txt`, 'AGENTS.md is a directory here'),
    )

    const recovered = yield* chat.pipe(
      Effect.catchTag('InstructionsUnreadable', (stopped) => Effect.succeed(stopped.path)),
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
      Effect.provide(services(workspace)),
    )

    expect(recovered).toBe(`${workspace}/AGENTS.md`)
  }),
)
