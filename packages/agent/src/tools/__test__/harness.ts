import { DateTime, Effect, FileSystem, Predicate, Stream } from 'effect'

import type { BunServices } from '@effect/platform-bun'
import type { Layer } from 'effect'
import type { AiError, Tool, Toolkit } from 'effect/unstable/ai'

import { toolkit } from '#tools/index.ts'
import { onDisk, services } from '#__test__/testing.ts'

import type { Handlers, Hooks, Tools } from '#tools/index.ts'

export type Outcome = Tool.Result<Tools[keyof Tools]>

/** How a test calls one tool: through the toolkit, answering with what it streams. */
export type Handle<A, E> = (
  tools: Toolkit.WithHandler<Tools>,
) => Effect.Effect<Stream.Stream<A, E>, AiError.AiError>

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

/**
 * The last result one tool streamed, as an effect over whatever handlers are provided,
 * so a test that has to move a clock or ask twice can run it inside its own program.
 */
export const outcome = <A, E>(
  handle: Handle<A, E>,
): Effect.Effect<A, AiError.AiError | E, Handlers> =>
  Effect.gen(function* () {
    const results = yield* Stream.runCollect(yield* handle(yield* toolkit))

    const last = results[results.length - 1]

    return last === undefined ? yield* Effect.die(new Error('the tool produced no result')) : last
  })

// Run one tool against `mounted`, whatever that layer put at the seam, and answer with
// the last result it streamed.
export const run = <A, E>(
  mounted: Layer.Layer<BunServices.BunServices | Handlers>,
  handle: Handle<A, E>,
): Promise<A> =>
  // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
  Effect.runPromise(outcome(handle).pipe(Effect.provide(mounted)))

// Run one tool, with whatever `hooks` puts at the seam; by default, the write Gate, as
// the agent has it.
export const call = <A, E>(root: string, handle: Handle<A, E>, hooks?: Hooks): Promise<A> =>
  run(services(root, hooks), handle)

export const text = (result: Outcome): string => (Predicate.isString(result) ? result : '')
