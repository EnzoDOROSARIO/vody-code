import { Console, Effect, FileSystem, Path, Schema } from 'effect'

import type { Layer } from 'effect'

import { Tool, Toolkit } from 'effect/unstable/ai'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { FileSystemRefused, refused } from './errors.ts'
import { modifiedAt } from './files.ts'
import { Workspace } from '#workspace.ts'

const MAX_MATCHES = 200

const STAT_CONCURRENCY = 32

const ALWAYS_EXCLUDED = ['.git', 'node_modules', 'dist']

// How much of a pattern is literal, so a pattern that names an excluded directory
// can reach into it anyway.
const literalPrefix = (pattern: string): string => {
  const wildcard = pattern.search(/[*?[{]/)

  return wildcard === -1 ? pattern : pattern.slice(0, wildcard)
}

const reachesInto = (prefix: string, entry: string): boolean =>
  prefix === entry || prefix.startsWith(`${entry}/`)

const glob = Tool.make('glob', {
  description: [
    'Find files matching a glob pattern; ** matches recursively. Returns files only, most recently',
    'modified first, so the useful matches come first when the list is cut short. Anything',
    'gitignored is skipped, along with .git, node_modules and dist — unless the pattern names one',
    'of those directly.',
  ].join(' '),
  parameters: Schema.Struct({ pattern: Schema.String }),
  success: Schema.String,
  failure: FileSystemRefused,
  failureMode: 'return',
})

export const toolkit: Toolkit.Toolkit<{ readonly glob: typeof glob }> = Toolkit.make(glob)

export const layer: Layer.Layer<
  Tool.HandlersFor<(typeof toolkit)['tools']>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> = toolkit.toLayer(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const root = yield* Workspace

    // git knows what is ignored, including nested .gitignores, the global ignore and
    // .git/info/exclude, and collapses a wholly ignored directory to one entry.
    const excludesFor = Effect.fn('excludesFor')(function* (pattern: string) {
      const listed = yield* spawner
        .string(
          ChildProcess.make(
            'git',
            ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
            { cwd: root },
          ),
        )
        .pipe(Effect.orElseSucceed(() => ''))

      const ignored = listed.split('\n').filter((entry) => entry !== '')

      const reachedInto = literalPrefix(pattern)

      return [...ALWAYS_EXCLUDED, ...ignored].flatMap((entry) => {
        const trimmed = entry.endsWith('/') ? entry.slice(0, -1) : entry

        return reachesInto(reachedInto, trimmed) ? [] : [trimmed, `${trimmed}/**`]
      })
    })

    return toolkit.of({
      glob: Effect.fn('glob')(function* ({ pattern }) {
        yield* Console.log(`glob ${pattern}`)

        const exclude = yield* excludesFor(pattern)

        const matches = yield* fs.glob(pattern, { exclude, root }).pipe(Effect.mapError(refused))

        const described = yield* Effect.forEach(
          matches,
          (match) =>
            fs.stat(path.resolve(root, match)).pipe(
              Effect.match({
                onFailure: () => [],
                onSuccess: (info) =>
                  info.type === 'File' ? [{ at: modifiedAt(info), path: match }] : [],
              }),
            ),
          { concurrency: STAT_CONCURRENCY },
        )

        const found = described
          .flat()
          .toSorted((left, right) => right.at - left.at || left.path.localeCompare(right.path))

        if (found.length === 0) {
          return '(no matches)'
        }

        const shown = found.slice(0, MAX_MATCHES).map((file) => file.path)

        return found.length > MAX_MATCHES
          ? [
              ...shown,
              `... (${found.length - MAX_MATCHES} more matches omitted, oldest first; narrow the pattern)`,
            ].join('\n')
          : shown.join('\n')
      }),
    })
  }),
)
