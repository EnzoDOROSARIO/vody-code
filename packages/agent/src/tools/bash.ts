import { Duration, Effect, FileSystem, Schema, Stream } from 'effect'

import { Tool, Toolkit } from 'effect/unstable/ai'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import { Workspace } from '#workspace.ts'

const MAX_OUTPUT_CHARACTERS = 30_000

const HELD_CHARACTERS = MAX_OUTPUT_CHARACTERS * 2

const DEFAULT_TIMEOUT_SECONDS = 120

// Exported for the tests, which name the ceiling rather than restating it, so the arm
// of `timedOut` they are aiming at stays the one they hit.
export const MAX_TIMEOUT_SECONDS = 600

export class CommandRefused extends Schema.TaggedError<CommandRefused>()('CommandRefused', {
  reason: Schema.String,
}) {}

export class CommandTimedOut extends Schema.TaggedError<CommandTimedOut>()('CommandTimedOut', {
  seconds: Schema.Int,
  output: Schema.String,
  reason: Schema.String,
}) {}

const Seconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

// What the model is told when its command is killed. A timeout the caller chose can be
// raised on the next attempt and the ceiling cannot, so only one of the two is worth
// suggesting a retry against. It is a function of its own because reaching the ceiling
// arm through the handler would mean waiting the ceiling out.
export const timedOut = (command: string, seconds: number): string =>
  seconds === MAX_TIMEOUT_SECONDS
    ? `bash killed \`${command}\` after ${seconds}s, the longest it will wait — narrow the work, or start it in the background if it is not meant to finish`
    : `bash killed \`${command}\` after ${seconds}s — run it again with a longer timeout_seconds, or in the background if it is not meant to finish`

type Output = {
  readonly collect: (text: string) => Effect.Effect<void>
  // Renders what is left and flushes it to the spill file, so it is run once, on
  // whichever way the command ended.
  readonly seal: Effect.Effect<string>
}

// Keeps the end of a command's output, which is where the error usually is, and
// spills the whole of it to a file the model can go and read when it did not fit.
// The file outlives the call on purpose; the operating system clears it.
const makeOutput = (fs: FileSystem.FileSystem): Effect.Effect<Output> =>
  Effect.sync(() => {
    let held = ''
    let total = 0
    let spill: string | undefined
    let abandoned = false

    const store = (text: string): Effect.Effect<void> =>
      abandoned
        ? Effect.void
        : Effect.gen(function* () {
            spill ??= yield* fs.makeTempFile({ prefix: 'vody-bash-', suffix: '.log' })

            yield* fs.writeFileString(spill, text, { flag: 'a' })
          }).pipe(
            // A spill that failed part way would name a file that does not hold what it
            // claims, so stop spilling and stop naming it. Only the file system saying
            // no is handled: a defect or an interrupt belongs to whoever ran the command.
            Effect.catch((error) =>
              Effect.sync(() => {
                abandoned = true
              }).pipe(
                Effect.tap(() => Effect.logDebug(`bash gave up spilling output: ${error.message}`)),
              ),
            ),
          )

    const collect = (text: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        total += text.length

        held += text

        if (held.length <= HELD_CHARACTERS) {
          return
        }

        // Trim by character, not by chunk: a chunk can be larger than the whole tail,
        // and dropping one whole would leave far less than the tail that was promised.
        // Trimming to the budget only once it is doubled keeps the copying amortised.
        const excess = held.length - MAX_OUTPUT_CHARACTERS

        const dropped = held.slice(0, excess)

        held = held.slice(excess)

        yield* store(dropped)
      })

    const seal = Effect.gen(function* () {
      const shown = held.slice(Math.max(0, held.length - MAX_OUTPUT_CHARACTERS))

      const omitted = total - shown.length

      if (omitted === 0) {
        return shown === '' ? '(no output)' : shown
      }

      yield* store(held)

      const where = abandoned || spill === undefined ? '' : `; full output at ${spill}`

      return `... (${omitted} earlier characters omitted${where})\n${shown}`
    })

    return { collect, seal }
  })

const bash = Tool.make('bash', {
  description: [
    'Run a shell command. The first line of the result is `exit <code>`. The rest is the command',
    'output, stdout and stderr interleaved — except that output which ran long is cut from the',
    'front to keep the end, and then the line after `exit <code>` says how much went and names a',
    'file holding all of it, which you can read or grep. Each call starts a fresh shell, so `cd`',
    'and exported variables do not carry over — write `cd x && y` in one command instead. stdin is',
    'closed, so a command that would prompt reads end-of-file instead of hanging. The command is',
    `killed after timeout_seconds, ${DEFAULT_TIMEOUT_SECONDS} by default and at most ${MAX_TIMEOUT_SECONDS}.`,
  ].join(' '),
  parameters: Schema.Struct({
    command: Schema.String,
    timeout_seconds: Schema.optionalKey(Seconds),
  }),
  success: Schema.String,
  failure: Schema.Union([CommandRefused, CommandTimedOut]),
  failureMode: 'return',
})

export const toolkit: Toolkit.Toolkit<{ readonly bash: typeof bash }> = Toolkit.make(bash)

export const handlers: Effect.Effect<
  Toolkit.HandlersFrom<(typeof toolkit)['tools']>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem

  const root = yield* Workspace

  return toolkit.of({
    bash: Effect.fn('bash')(function* ({ command, timeout_seconds: requested }) {
      const seconds = Math.min(requested ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)

      const output = yield* makeOutput(fs)

      const run = Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make('sh', ['-c', command], {
              cwd: root,
              stdin: 'ignore',
              killSignal: 'SIGTERM',
              forceKillAfter: Duration.seconds(2),
            }),
          )

          yield* Stream.runForEach(Stream.decodeText(handle.all), output.collect)

          return yield* handle.exitCode
        }),
      ).pipe(
        Effect.mapError(
          (error) =>
            new CommandRefused({
              reason: `bash could not run \`${command}\`: ${error.message}`,
            }),
        ),
      )

      const code = yield* run.pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(seconds),
          orElse: () =>
            Effect.flatMap(output.seal, (shown) =>
              Effect.fail(
                new CommandTimedOut({
                  seconds,
                  output: shown,
                  reason: timedOut(command, seconds),
                }),
              ),
            ),
        }),
      )

      const shown = yield* output.seal

      return `exit ${code}\n${shown}`
    }),
  })
})
