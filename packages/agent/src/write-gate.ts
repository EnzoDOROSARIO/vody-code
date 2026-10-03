import { Config, Effect, FileSystem, Option, Path } from 'effect'

import type { PlatformError } from 'effect'

import { Judge } from './judge.ts'
import { Perimeter, under } from './perimeter.ts'
import { Request } from './request.ts'
import { refused } from './tools/errors.ts'
import { ActRefused, derive, explained, Verdict } from './verdict.ts'
import { Workspace } from './workspace.ts'
import { definition, policy } from './write-questions.ts'

import type { JudgeDidNotAnswer } from './judge.ts'
import type { Containment } from './perimeter.ts'
import type { FileSystemRefused } from './tools/errors.ts'
import type { Hooks } from './tools/hooks.ts'
import type { Call } from './tools/toolkit.ts'
import type { Facts } from './write-questions.ts'

/**
 * The Gate in front of the two tools that write. A write that lands inside the
 * Perimeter goes ahead unasked; any other is put to the Judge, with every fact about it
 * that can be found out here, and goes ahead only on the Verdict derived from the
 * Judge's answers.
 */
export const hooks: Effect.Effect<
  Hooks,
  never,
  FileSystem.FileSystem | Judge | Path.Path | Perimeter | Workspace
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const judge = yield* Judge
  const perimeter = yield* Perimeter

  const workspace = yield* Workspace

  // The home directory by its real path, since that is the form a landing path is in.
  // One that cannot be resolved does not exist yet, and a write can still create it, so
  // its name is kept, normalised the way a real path is, so that a trailing slash or a
  // `..` in HOME does not hide the writes under it. With no HOME at all, nothing is under
  // a home.
  const home = yield* Effect.option(Config.String('HOME')).pipe(
    Effect.map(
      Option.map((named) =>
        fs.realPath(named).pipe(Effect.orElseSucceed(() => path.resolve(named))),
      ),
    ),
    Effect.flatMap(Effect.transposeOption),
  )

  // Whether a `.git` sits in `directory` or anywhere above it. The file system root is
  // its own parent, which ends the walk.
  const insideAnotherRepository = (
    directory: string,
  ): Effect.Effect<boolean, PlatformError.PlatformError> => {
    const parent = path.dirname(directory)

    return fs.exists(path.join(directory, '.git')).pipe(
      Effect.filterOrElse(
        (found) => found || parent === directory,
        () => insideAnotherRepository(parent),
      ),
    )
  }

  // Everything the Judge is told about a write, found out here rather than asked.
  const established = (
    tool: Facts['tool'],
    { metadata, path: landing }: Containment,
  ): Effect.Effect<Facts, PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const request = yield* Request

      return {
        tool,
        path: landing,
        exists: yield* fs.exists(landing),
        underHome: Option.exists(home, (directory) => under(directory, landing, path.sep)),
        // The working tree's own metadata is not another repository, though a walk up
        // from it finds a `.git`: the tree's own, or in a linked worktree, the main
        // checkout's, whose common directory holds this tree's hooks. Nor is whatever
        // repository the tree is itself nested in the one that write lands in.
        insideAnotherRepository: metadata
          ? false
          : yield* insideAnotherRepository(path.dirname(landing)),
        insideRepositoryMetadata: metadata,
        perimeter: Option.getOrNull(perimeter.root),
        workspace,
        request: Option.getOrNull(request),
      }
    })

  // The Gate resolves the path exactly as the tool it stands in front of will, so what
  // is examined is where the write is about to go, not where the model wrote it.
  // Stryker disable next-line StringLiteral: the name only labels the span, which nothing
  // in the package reads.
  const examine = Effect.fn('WriteGate.examine')(function* (
    call: Call<'edit_file' | 'write_file'>,
  ): Effect.fn.Return<void, ActRefused | FileSystemRefused | JudgeDidNotAnswer> {
    const containment = yield* perimeter
      .contains(path.resolve(workspace, call.params.path))
      .pipe(Effect.mapError(refused))

    if (containment.inside) {
      return
    }

    const landing = containment.path

    const facts = yield* established(call.name, containment).pipe(Effect.mapError(refused))

    const answers = yield* judge.judge(definition, facts)

    // No Perimeter covers a Workspace with no repository above it, one inside a
    // repository's own `.git`, one under a `.git` file naming nothing, and one whose
    // directories cannot be looked into, so the refusal says what was found rather than
    // which it was.
    const outside = Option.match(perimeter.root, {
      onNone: () => `outside any working tree, since none could be found from ${workspace}`,
      onSome: (root) => `outside the working tree at ${root}`,
    })

    yield* Verdict.$match(derive(policy, answers), {
      Allowed: () => Effect.void,
      Refused: ({ tripped }) =>
        Effect.fail(
          new ActRefused({
            tripped,
            reason: `${call.name} will not write ${call.params.path}: it would land at ${landing}, ${outside}, and the Judge's answers refuse it (${explained(tripped)}). The refusal is final, so do not try the same write again: do the work another way, or tell the person what you meant to write and why`,
          }),
        ),
    })
  })

  return { edit_file: examine, write_file: examine }
})
