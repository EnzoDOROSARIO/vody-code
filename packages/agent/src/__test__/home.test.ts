import { afterEach, expect, it } from '@effect/vitest'
import { Effect, FileSystem, Option } from 'effect'

import { homeFrom, onDisk, removeWorkspaces, temporary, write } from './testing.ts'

afterEach(removeWorkspaces)

// The home directory is compared by where it really is, as the landing path a write is
// measured against is: a home reached through a link is the directory the link leads to.
it.live('a home that resolves is the directory it really is', () =>
  Effect.gen(function* () {
    const base = yield* Effect.promise(() => onDisk(temporary))

    const home = `${base}/home`

    yield* Effect.promise(() => write(`${home}/.profile`, 'export EDITOR=nano\n'))

    const link = `${base}/link`

    yield* Effect.promise(() =>
      onDisk(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          yield* fs.symlink(home, link).pipe(Effect.orDie)
        }),
      ),
    )

    const real = yield* Effect.promise(() =>
      onDisk(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem

          return yield* fs.realPath(home).pipe(Effect.orDie)
        }),
      ),
    )

    expect(yield* homeFrom({ HOME: home })).toEqual(Option.some(real))
    expect(yield* homeFrom({ HOME: link })).toEqual(Option.some(real))
  }),
)

// A HOME naming a directory not there yet is still the home a write can create, kept
// under its normalised name, so a trailing slash or a `..` in it cannot hide the writes
// under it.
it.live('a home that does not exist yet is kept under its normalised name', () =>
  Effect.gen(function* () {
    const base = yield* Effect.promise(() => onDisk(temporary))

    expect(yield* homeFrom({ HOME: `${base}/home` })).toEqual(Option.some(`${base}/home`))
    expect(yield* homeFrom({ HOME: `${base}/home/` })).toEqual(Option.some(`${base}/home`))
    expect(yield* homeFrom({ HOME: `${base}/somewhere/../home` })).toEqual(
      Option.some(`${base}/home`),
    )
  }),
)

// With no HOME at all, there is no home for anything to be under.
it.live('no HOME at all means no home', () =>
  Effect.gen(function* () {
    expect(yield* homeFrom({})).toEqual(Option.none())
  }),
)
