import { expect, it } from '@effect/vitest'
import { Effect, Stream } from 'effect'

import type { AiError } from 'effect/ai'

import { CommandRefused, toolkit as bash } from '#tools/bash.ts'
import { before, Hooks, watched } from '#tools/hooks.ts'

import type { Handler } from '#tools/hooks.ts'

const succeeded: Handler<'bash'> = () => Effect.succeed('ran')

// The seam with nothing under it but the one tool, so no file is touched and no command
// is run: whatever hooks are given, and the handler behind them.
const seam = (hooks: Hooks, handler: Handler<'bash'> = succeeded) =>
  bash.toLayer({ bash: before(hooks, 'bash', handler) })

// One `bash` call's answer, made as the stream is pulled — the moment the loop's own
// `watched` has the Passage around it — rather than when the stream is built.
const answer = () =>
  Stream.unwrap(
    Effect.gen(function* () {
      const kit = yield* bash

      return yield* kit.handle('bash', { command: 'echo hi' })
    }),
  )

// One call through the seam with a fresh Passage around it: what the loop asks of it —
// whether the call failed, and whether any act got through — and nothing else.
const called = (
  hooks: Hooks,
  handler: Handler<'bash'> = succeeded,
): Effect.Effect<{ readonly failed: boolean; readonly passed: boolean }, AiError.AiError> =>
  Effect.gen(function* () {
    const { passed, stream } = yield* watched(answer())

    const results = yield* Stream.runCollect(stream)

    const last = results[results.length - 1]

    return { failed: last?.isFailure ?? false, passed: yield* passed }
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
    Effect.provide(seam(hooks, handler)),
  )

it.live('a hook that passes and a tool that succeeds record a passage', () =>
  Effect.gen(function* () {
    expect(yield* called({ bash: () => Effect.void })).toEqual({ failed: false, passed: true })
  }),
)

it.live('a hook that fails stops the act, and records nothing', () =>
  Effect.gen(function* () {
    const outcome = yield* called({
      bash: () => Effect.fail(new CommandRefused({ reason: 'stopped at the seam' })),
    })

    expect(outcome).toEqual({ failed: true, passed: false })
  }),
)

// The Gate opened and the tool then did nothing: the act did not happen, so nothing is
// recorded and the count it would have cleared stands.
it.live('a hook that passes with a tool that fails on its own records nothing', () =>
  Effect.gen(function* () {
    const outcome = yield* called({ bash: () => Effect.void }, () =>
      Effect.fail(new CommandRefused({ reason: 'the tool itself' })),
    )

    expect(outcome).toEqual({ failed: true, passed: false })
  }),
)

it.live('a tool with no hook in front of it is never recorded', () =>
  Effect.gen(function* () {
    expect(yield* called({})).toEqual({ failed: false, passed: false })
  }),
)

// No call of the model is around the act, so the Passage is the reference's own default:
// the record has nowhere to go and the act runs anyway. This is the harness, a Gate's
// own tests, and every direct run of a handler.
it.live('outside any call of the model, an act records into nothing and runs', () =>
  Effect.gen(function* () {
    const results = yield* Stream.runCollect(answer())

    expect(results[results.length - 1]?.isFailure).toBe(false)
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a test is an entry point
    Effect.provide(seam({ bash: () => Effect.void })),
  ),
)

// The seam with nothing provided at it, which is where its default lives: no hook for
// any tool, so every tool runs unexamined.
it.live('with nothing at the seam, no tool has a hook', () =>
  Effect.gen(function* () {
    expect(yield* Hooks).toEqual({})
  }),
)
