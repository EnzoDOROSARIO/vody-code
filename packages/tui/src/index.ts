import type { Effect } from 'effect'
import { Console } from 'effect'

import pkg from '../package.json' with { type: 'json' }

/** Human-readable banner shown when the TUI starts. */
export const banner = (version: string): string => `vody-code tui v${version}`

/** The TUI program. Run it from an entrypoint with `BunRuntime.runMain`. */
export const main: Effect.Effect<void> = Console.log(banner(pkg.version))
