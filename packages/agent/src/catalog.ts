import { Context, Effect, FileSystem, Layer, Option, Path, Predicate, Schema } from 'effect'
import { Yaml } from 'effect/encoding'

import type { PlatformError } from 'effect'

import { Home } from './home.ts'
import { Workspace } from './workspace.ts'

// Where the Workspace and the home directory keep the Skills written for them, beside
// the instructions a Workspace writes for whoever works in it.
const SKILLS = ['.agents', 'skills'] as const

const INSTRUCTIONS = 'SKILL.md'

// A SKILL.md opens with its frontmatter between two fences, and what follows is the
// Skill's instructions. Both fences are required: a file with no frontmatter, or one
// whose fence is never closed, has no name and is refused for that, rather than parsed
// into something half said.
const OPENING = /^---[ \t]*\r?\n/

const CLOSING = /\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * A Skill that is there and cannot be used stops the session, the way unreadable
 * workspace instructions do: starting anyway would mean an agent missing a Skill its
 * author thought it had, and neither the model nor whoever asked would know.
 */
export class SkillUnreadable extends Schema.TaggedError<SkillUnreadable>()('SkillUnreadable', {
  path: Schema.String,
  reason: Schema.String,
}) {
  // The other error in the package that reaches a terminal rather than the model:
  // `NodeRuntime.runMain` prints only `cause.message`, so both fields have to be in it.
  override get message(): string {
    return `${this.path} could not be read: ${this.reason}`
  }
}

/**
 * One Skill the agent may load: what it is for, where its folder is, and what its
 * SKILL.md says below the frontmatter.
 */
export type Skill = {
  readonly description: string
  /** The Skill folder's absolute path: where the files its instructions point to are read from. */
  readonly path: string
  /** The SKILL.md with the frontmatter left off: the instructions a load hands back. */
  readonly body: string
}

/** The frontmatter a SKILL.md opens with, and the body below it. */
type Frontmatter = {
  readonly frontmatter: string
  readonly body: string
}

// Decoded one key at a time, so the failure says which key was wrong: a missing name and
// a missing description are different edits. Each decode ignores the keys it does not
// name, which is how a frontmatter written for another agent keeps its extra keys.
const Name = Schema.Struct({ name: Schema.String })

const Description = Schema.Struct({ description: Schema.String })

const Disable = Schema.Struct({ 'disable-model-invocation': Schema.optional(Schema.Boolean) })

const absent = (error: PlatformError.PlatformError): boolean =>
  Predicate.isTagged(error.reason, 'NotFound')

const broken = (path: string, reason: string): SkillUnreadable =>
  new SkillUnreadable({ path, reason })

// The frontmatter block, and the instructions under it.
const split = (text: string): Frontmatter => {
  const opening = OPENING.exec(text)

  if (opening === null) {
    return { frontmatter: '', body: text }
  }

  const rest = text.slice(opening[0].length)
  const closing = CLOSING.exec(rest)

  if (closing === null) {
    return { frontmatter: '', body: text }
  }

  return {
    frontmatter: rest.slice(0, closing.index),
    body: rest.slice(closing.index + closing[0].length),
  }
}

// Read rather than ask and then read: one syscall, and a `SKILL.md` that is a directory
// arrives as the failure it is. A folder with no SKILL.md is not a Skill, so its absence
// is none; any other failure to read one stops the session.
const read = (
  file: string,
): Effect.Effect<Option.Option<string>, SkillUnreadable, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.readFileString(file).pipe(
      Effect.asSome,
      Effect.catchIf(absent, () => Effect.succeed(Option.none<string>())),
      Effect.mapError((error) => broken(file, error.message)),
    ),
  )

// An entry that is not a directory — a stray file, or a link to one — is passed over: a
// Skill is a folder, and only a folder can have a SKILL.md at its top. A link to a
// folder is one, because `stat` follows it. A dangling link has no Skill behind it and
// is passed over with the rest.
const isDirectory = (
  folder: string,
): Effect.Effect<boolean, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.stat(folder).pipe(
      Effect.map((info) => info.type === 'Directory'),
      Effect.catchIf(absent, () => Effect.succeed(false)),
    ),
  )

// Every Skill is validated, including the ones marked `disable-model-invocation`: a
// broken file is refused whether or not the agent would have been shown it. The marked
// ones are left out of the Catalog only once they have passed — but their names are kept,
// because a name that exists here still hides a home Skill that shares it.
const validated = (
  entry: string,
  folder: string,
  file: string,
  text: string,
): Effect.Effect<readonly [string, Option.Option<Skill>], SkillUnreadable> =>
  Effect.gen(function* () {
    const { frontmatter, body } = split(text)

    const parsed = yield* Effect.try({
      try: () => Yaml.parse(frontmatter),
      catch: (error) =>
        broken(
          file,
          `the frontmatter does not parse: ${error instanceof Error ? error.message : String(error)}`,
        ),
    })

    const name = yield* Schema.decodeUnknownEffect(Name)(parsed).pipe(
      Effect.map((decoded) => decoded.name),
      Effect.mapError(() => broken(file, 'the name is missing or empty')),
    )

    if (name === '') {
      return yield* broken(file, 'the name is missing or empty')
    }

    const description = yield* Schema.decodeUnknownEffect(Description)(parsed).pipe(
      Effect.map((decoded) => decoded.description.trim()),
      Effect.mapError(() => broken(file, 'the description is missing or empty')),
    )

    if (description === '') {
      return yield* broken(file, 'the description is missing or empty')
    }

    const disabled = yield* Schema.decodeUnknownEffect(Disable)(parsed).pipe(
      Effect.map(({ 'disable-model-invocation': flag }) => flag === true),
      Effect.mapError(() => broken(file, 'disable-model-invocation is not a boolean')),
    )

    if (name !== entry) {
      return yield* broken(file, `the name "${name}" does not match the folder "${entry}"`)
    }

    return [
      entry,
      disabled ? Option.none<Skill>() : Option.some({ description, path: folder, body }),
    ]
  })

// One entry of the skills directory, if it is a Skill: a folder, with a SKILL.md that
// validates. A folder that is not one is passed over; anything else wrong with a
// SKILL.md is a broken Skill, and is named by its path.
const candidate = (
  directory: string,
  entry: string,
): Effect.Effect<
  Option.Option<readonly [string, Option.Option<Skill>]>,
  SkillUnreadable | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path

    const folder = path.resolve(directory, entry)

    if (!(yield* isDirectory(folder))) {
      return Option.none()
    }

    const file = path.join(folder, INSTRUCTIONS)

    const text = yield* read(file)

    if (Option.isNone(text)) {
      return Option.none()
    }

    return Option.some(yield* validated(entry, folder, file, text.value))
  })

// One skills directory, kept by name: the Skill itself when the agent may load it, and
// none for one its author kept for the person alone. Every validated name is a key,
// whether or not it reached the Catalog, because a name here is what hides a home Skill
// of the same name.
const readSkills = (
  directory: string,
): Effect.Effect<
  ReadonlyMap<string, Option.Option<Skill>>,
  SkillUnreadable | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // No skills folder is a place that keeps no Skills, not a failure. Any other failure
    // to look inside one stops the session before the screen exists.
    const entries = yield* fs
      .readDirectory(directory)
      .pipe(Effect.catchIf(absent, () => Effect.succeed([])))

    const found = yield* Effect.forEach(entries, (entry) => candidate(directory, entry))

    return new Map(found.flatMap((entry) => Option.toArray(entry)))
  })

/**
 * The Skills the agent may load, by name: what the session is told as it begins, and
 * what a load hands back. A required port rather than a defaulted reference: a
 * composition that forgets it is a compile error, not an empty Catalog at runtime.
 *
 * The Workspace's folder and the home directory's are read once, while the session is
 * built, so the Catalog stays the same until the session ends and the disk is read once
 * for the whole run. Where both hold a name, the Workspace's Skill is the one in the
 * Catalog — and its name hides the home one even when the Workspace kept its own for the
 * person alone, so neither is listed.
 */
export class Catalog extends Context.Service<Catalog, ReadonlyMap<string, Skill>>()(
  'agent/Catalog',
) {
  static readonly layer: Layer.Layer<
    Catalog,
    SkillUnreadable | PlatformError.PlatformError,
    FileSystem.FileSystem | Home | Path.Path | Workspace
  > = Layer.effect(
    Catalog,
    Effect.gen(function* () {
      const path = yield* Path.Path
      const home = yield* Home
      const workspace = yield* Workspace

      const workspaceSkills = yield* readSkills(path.join(workspace, ...SKILLS))

      const homeSkills = yield* Option.match(home, {
        onNone: () => Effect.succeed(new Map<string, Option.Option<Skill>>()),
        onSome: (directory) => readSkills(path.join(directory, ...SKILLS)),
      })

      const catalog = new Map<string, Skill>()

      // The Workspace's Skills first, as the ones written for this project. Its names —
      // the ones kept for the person alone included — then hide every home Skill that
      // shares them, so the model is never left to guess which of two it may load.
      for (const [name, skill] of workspaceSkills) {
        if (Option.isSome(skill)) {
          catalog.set(name, skill.value)
        }
      }

      for (const [name, skill] of homeSkills) {
        if (workspaceSkills.has(name)) {
          continue
        }

        if (Option.isSome(skill)) {
          catalog.set(name, skill.value)
        }
      }

      return catalog
    }),
  )
}
