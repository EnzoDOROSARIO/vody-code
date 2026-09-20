import { DateTime, Effect, FileSystem, Predicate, Stream } from 'effect'

import type { AiError, Tool, Toolkit } from 'effect/unstable/ai'

import { toolkit } from '#tools/index.ts'
import { onDisk, services, temporary } from '#__test__/testing.ts'

type Tools = (typeof toolkit)['tools']

export type Outcome = Tool.Result<Tools[keyof Tools]>

// A workspace with a file to find inside it and one outside, so a test can show
// that a tool reaches past the root the way bash would.
export const workspace = (): Promise<string> =>
  onDisk(
    Effect.gen(function* () {
      const base = yield* temporary

      yield* Effect.promise(() => Bun.write(`${base}/work/inside/keep.txt`, 'kept'))
      yield* Effect.promise(() => Bun.write(`${base}/outside/secret.txt`, 'secret'))

      return `${base}/work`
    }),
  )

// Set a file's modified time, so a test can order what glob returns or age a file
// past the read that saw it.
export const touch = (target: string, iso: string): Promise<void> =>
  onDisk(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const at = DateTime.toDateUtc(DateTime.makeUnsafe(iso))

      yield* fs.utimes(target, at, at).pipe(Effect.orDie)
    }),
  )

export const call = <A, E>(
  root: string,
  handle: (
    tools: Toolkit.WithHandler<Tools>,
  ) => Effect.Effect<Stream.Stream<A, E>, AiError.AiError>,
): Promise<A> => {
  const program = Effect.gen(function* () {
    const results = yield* Stream.runCollect(yield* handle(yield* toolkit))

    const last = results[results.length - 1]

    return last === undefined ? yield* Effect.die(new Error('the tool produced no result')) : last
  })

  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
  return Effect.runPromise(program.pipe(Effect.provide(services(root))))
}

export const text = (result: Outcome): string => (Predicate.isString(result) ? result : '')
