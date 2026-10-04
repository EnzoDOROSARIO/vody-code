import { afterEach, expect, it } from '@effect/vitest'
import { NodeServices } from '@effect/platform-node'
import { Effect, Layer, Predicate, Ref, Schema } from 'effect'

import type { PlatformError } from 'effect'
import type { Chat } from 'effect/ai'

import { Catalog, SkillUnreadable } from '#catalog.ts'
import { chat } from '#prompt.ts'
import { Workspace } from '#workspace.ts'

import type { InstructionsUnreadable } from '#prompt.ts'

import { onDisk, removeWorkspaces, symlink, temporary, write } from './testing.ts'

afterEach(removeWorkspaces)

// The standing instructions the model works under, pinned in full as `prompt.test.ts`
// pins them: a workspace with no Skills must be handed byte for byte this prompt.
const standing = (workspace: string): string =>
  [
    'You are an expert coding assistant operating inside Vody Code, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.',
    'Be concise in your responses.',
    'Show file paths clearly when working with files',
    `You are operating in ${workspace}`,
  ].join('\n')

// The Skills section, pinned in full apart from the list it carries. Ticket #29 amends
// this wording when `load_skill` arrives; this literal is what it will change.
const section = (skills: ReadonlyArray<readonly [string, string]>): string =>
  [
    '<skills>',
    'A Skill is a folder of instructions for one kind of work, named and described by the SKILL.md at its top. These are the Skills available to you:',
    ...skills.map(([name, description]) => `- ${name}: ${description}`),
    '</skills>',
  ].join('\n')

// The real catalog, reading the workspace's `.agents/skills/` over the platform's own
// file system: the session-startup seam, where a broken Skill stops the session.
const reading = (
  workspace: string,
): Layer.Layer<
  NodeServices.NodeServices | Catalog | Workspace,
  SkillUnreadable | PlatformError.PlatformError
> =>
  Catalog.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(Workspace, workspace)),
  )

// What the conversation opened with, over a workspace read for real.
const instructions = (workspace: string): Effect.Effect<string, StartupRefusal> =>
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
    Effect.provide(reading(workspace)),
  )

type StartupRefusal = InstructionsUnreadable | SkillUnreadable | PlatformError.PlatformError

const refusal = (workspace: string): Effect.Effect<StartupRefusal, Chat.Chat> =>
  // The Catalog is built before the conversation is, so a refusal it raises arrives as
  // the build's failure: the flip has to sit outside the provide, where that failure
  // lands in the effect's error channel.
  chat.pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
    Effect.provide(reading(workspace)),
    Effect.flip,
  )

// The broken Skill the test arranged, narrowed: anything else reaching here is a defect
// rather than a failure to assert.
const broken = (workspace: string): Effect.Effect<SkillUnreadable, Chat.Chat> =>
  refusal(workspace).pipe(
    Effect.filterOrElse(Schema.is(SkillUnreadable), () =>
      Effect.die('the refusal was not a broken Skill'),
    ),
  )

const skill = (
  workspace: string,
  name: string,
  frontmatter: string,
  body = 'Do the work.',
): Promise<void> =>
  write(`${workspace}/.agents/skills/${name}/SKILL.md`, `---\n${frontmatter}\n---\n${body}`)

it.live('a workspace with no Skills is handed exactly the prompt it is handed today', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    expect(yield* instructions(workspace)).toBe(standing(workspace))
  }),
)

it.live('the Skills are listed in full, sorted by name', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() =>
      skill(workspace, 'zebra', 'name: zebra\ndescription: Does zebra work'),
    )
    yield* Effect.promise(() =>
      skill(workspace, 'alpha', 'name: alpha\ndescription: Does alpha work'),
    )

    expect(yield* instructions(workspace)).toBe(
      [
        standing(workspace),
        section([
          ['alpha', 'Does alpha work'],
          ['zebra', 'Does zebra work'],
        ]),
      ].join('\n\n'),
    )
  }),
)

it.live('the Skills follow the workspace instructions when it has written some', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => write(`${workspace}/AGENTS.md`, '# House rules\n\nRun the tests.'))
    yield* Effect.promise(() =>
      skill(workspace, 'alpha', 'name: alpha\ndescription: Does alpha work'),
    )

    expect(yield* instructions(workspace)).toBe(
      [
        standing(workspace),
        `<project_instructions path="${workspace}/AGENTS.md">\n# House rules\n\nRun the tests.\n</project_instructions>`,
        section([['alpha', 'Does alpha work']]),
      ].join('\n\n'),
    )
  }),
)

it.live('a Skill its author kept for the person alone is left out of the Catalog', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() =>
      skill(
        workspace,
        'mine',
        'name: mine\ndescription: Kept for me\ndisable-model-invocation: true',
      ),
    )
    yield* Effect.promise(() =>
      skill(workspace, 'yours', 'name: yours\ndescription: Shared with the agent'),
    )

    expect(yield* instructions(workspace)).toBe(
      [standing(workspace), section([['yours', 'Shared with the agent']])].join('\n\n'),
    )
  }),
)

it.live('an entry that is not a Skill folder is passed over, without complaint', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() =>
      skill(workspace, 'alpha', 'name: alpha\ndescription: Does alpha work'),
    )
    // A folder of shared material beside the Skills: no SKILL.md at its top.
    yield* Effect.promise(() =>
      write(`${workspace}/.agents/skills/material/notes.txt`, 'shared material'),
    )
    // A plain file among the folders: no folder, so no SKILL.md either.
    yield* Effect.promise(() =>
      write(`${workspace}/.agents/skills/stray.txt`, 'not a Skill at all'),
    )

    expect(yield* instructions(workspace)).toBe(
      [standing(workspace), section([['alpha', 'Does alpha work']])].join('\n\n'),
    )
  }),
)

it.live('a Skill folder that is a symbolic link is followed', () =>
  Effect.gen(function* () {
    const base = yield* Effect.promise(() => onDisk(temporary))
    const workspace = `${base}/work`

    yield* Effect.promise(() =>
      write(
        `${base}/elsewhere/linked/SKILL.md`,
        '---\nname: linked\ndescription: Lives elsewhere\n---\nDo the work.',
      ),
    )
    yield* Effect.promise(() =>
      symlink(`${base}/elsewhere/linked`, `${workspace}/.agents/skills/linked`),
    )

    expect(yield* instructions(workspace)).toBe(
      [standing(workspace), section([['linked', 'Lives elsewhere']])].join('\n\n'),
    )
  }),
)

it.live('a quoted description is read as its text', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() =>
      skill(
        workspace,
        'quoted',
        'name: quoted\ndescription: "Does: quoted work, exactly as written"',
      ),
    )

    expect(yield* instructions(workspace)).toBe(
      [standing(workspace), section([['quoted', 'Does: quoted work, exactly as written']])].join(
        '\n\n',
      ),
    )
  }),
)

it.live('a folded description is read as its text', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() =>
      skill(
        workspace,
        'folded',
        'name: folded\ndescription: >\n  Does folded work,\n  across two lines',
      ),
    )

    expect(yield* instructions(workspace)).toBe(
      [standing(workspace), section([['folded', 'Does folded work, across two lines']])].join(
        '\n\n',
      ),
    )
  }),
)

it.live('a frontmatter key vody-code does not use is ignored', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() =>
      skill(
        workspace,
        'borrowed',
        [
          'name: borrowed',
          'description: Written for several agents',
          'argument-hint: "[file]"',
          'license: MIT',
          'metadata:',
          '  version: 2',
        ].join('\n'),
      ),
    )

    expect(yield* instructions(workspace)).toBe(
      [standing(workspace), section([['borrowed', 'Written for several agents']])].join('\n\n'),
    )
  }),
)

// Where a broken Skill stops the session: the message names the file and the reason,
// because `NodeRuntime.runMain` prints the message and nothing else.
it.live('a SKILL.md that cannot be read stops the session, naming the file and the reason', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() =>
      write(
        `${workspace}/.agents/skills/broken/SKILL.md/nested.txt`,
        'SKILL.md is a directory here',
      ),
    )

    const stopped = yield* broken(workspace)

    expect(stopped.path).toBe(`${workspace}/.agents/skills/broken/SKILL.md`)
    // What the file system said, not a sentence of this module's own.
    expect(stopped.reason).toContain('FileSystem.readFile')
  }),
)

it.live('frontmatter that does not parse stops the session', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => skill(workspace, 'broken', 'name: [unterminated'))

    const stopped = yield* broken(workspace)

    expect(stopped.path).toBe(`${workspace}/.agents/skills/broken/SKILL.md`)
    expect(stopped.reason).toContain('the frontmatter does not parse')
  }),
)

it.live('a Skill with no name stops the session', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => skill(workspace, 'broken', 'description: Says what it does'))

    const stopped = yield* broken(workspace)

    expect(stopped.reason).toBe('the name is missing or empty')
  }),
)

it.live('a Skill with an empty description stops the session', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => skill(workspace, 'broken', 'name: broken\ndescription: ""'))

    const stopped = yield* broken(workspace)

    expect(stopped.reason).toBe('the description is missing or empty')
  }),
)

it.live('a Skill whose name does not match its folder stops the session', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() =>
      skill(workspace, 'broken', 'name: elsewhere\ndescription: Says what it does'),
    )

    const stopped = yield* broken(workspace)

    expect(stopped.reason).toBe('the name "elsewhere" does not match the folder "broken"')
  }),
)

it.live('a Skill whose disable flag is not a boolean stops the session', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() =>
      skill(
        workspace,
        'broken',
        'name: broken\ndescription: Says what it does\ndisable-model-invocation: sometimes',
      ),
    )

    const stopped = yield* broken(workspace)

    expect(stopped.reason).toBe('disable-model-invocation is not a boolean')
  }),
)

// A Skill kept for the person alone is still checked: a broken file must not lie around
// unnoticed just because the agent would not have been shown it.
it.live('a broken Skill is refused even when the agent would not have been shown it', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() =>
      write(
        `${workspace}/.agents/skills/broken/SKILL.md`,
        '---\nname: broken\ndisable-model-invocation: true\n---\nDo the work.',
      ),
    )

    const stopped = yield* broken(workspace)

    expect(stopped.reason).toBe('the description is missing or empty')
  }),
)

it.live('the refusal carries its path and reason in the message the terminal prints', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => skill(workspace, 'broken', 'name: elsewhere\ndescription: Has one'))

    const stopped = yield* broken(workspace)

    expect(stopped.message).toContain(stopped.path)
    expect(stopped.message).toContain(stopped.reason)
  }),
)

it.live('the refusal answers to the tag its type promises', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => skill(workspace, 'broken', 'description: Says what it does'))

    const recovered = yield* chat.pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
      Effect.provide(reading(workspace)),
      Effect.catchTag('SkillUnreadable', (stopped) => Effect.succeed(stopped.path)),
    )

    expect(recovered).toBe(`${workspace}/.agents/skills/broken/SKILL.md`)
  }),
)

// Nothing there is a Skill yet: a skills path that cannot be looked into is the
// platform's own failure, and it stops the session before the screen exists.
it.live('a skills path that cannot be read stops the session', () =>
  Effect.gen(function* () {
    const workspace = yield* Effect.promise(() => onDisk(temporary))

    yield* Effect.promise(() => write(`${workspace}/.agents/skills`, 'not a directory'))

    const stopped = yield* refusal(workspace)

    expect(Predicate.isTagged(stopped, 'PlatformError')).toBe(true)
  }),
)
