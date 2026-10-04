import chalk from 'chalk'
import { renderToString } from 'ink'

import { start } from '#frame.ts'

import type { ReactElement } from 'react'
import type { Screen, Viewport } from '#frame.ts'

export const GREY_BACKGROUND = '\u001B[100m'

export const BOLD = '\u001B[1m'

export const DIM = '\u001B[2m'

export const ITALIC = '\u001B[3m'

export const UNDERLINE = '\u001B[4m'

export const STRIKETHROUGH = '\u001B[9m'

export const CYAN = '\u001B[36m'

// Ink paints through chalk, which keeps quiet when nothing on the other end is a
// terminal. Turning it up around one render is the only way to see what a real one
// gets, and the render is synchronous, so nothing else observes the raised level.
//
// This only works while `chalk` here resolves to the copy Ink paints with. Should the
// two ever part — Ink moving to a major this package does not follow — the render
// comes back bare, so the check below names that cause instead of leaving the
// assertions underneath to fail as if the styling had been dropped.
// The mirror image, for whatever is painted on the way to words a test is after. chalk
// reads FORCE_COLOR from the environment when it loads, and a terminal that exports it
// would paint escapes into every line, so the level is pinned at nothing around the
// call, the same way `colourful` pins it at everything around a render.
export const unpainted = <A>(paint: () => A): A => {
  const level = chalk.level

  chalk.level = 0

  try {
    return paint()
  } finally {
    chalk.level = level
  }
}

export const plain = (node: ReactElement, columns = 80): string =>
  unpainted(() => renderToString(node, { columns }))

export const colourful = (node: ReactElement, columns = 80): string => {
  const level = chalk.level

  chalk.level = 3

  try {
    const painted = renderToString(node, { columns })

    if (!painted.includes('\u001B[')) {
      throw new Error('chalk painted nothing: this package and ink hold separate copies')
    }

    return painted
  } finally {
    chalk.level = level
  }
}

// The mirror of `colourful` for code that paints a string itself rather than through a
// render: the same raised level, the same check that something came back painted, and
// the same restore.
export const painted = (paint: () => string): string => {
  const level = chalk.level

  chalk.level = 3

  try {
    const result = paint()

    if (!result.includes('\u001B[')) {
      throw new Error(
        'chalk painted nothing: this test and the code under test hold separate copies',
      )
    }

    return result
  } finally {
    chalk.level = level
  }
}

/**
 * A screen to start a case from: the parts given, over the frame's start at a viewport
 * that defaults to Ink's own fallback, 80 by 24.
 */
export const screen = (
  parts: Partial<Screen> = {},
  viewport: Viewport = { columns: 80, rows: 24 },
): Screen => ({ ...start(viewport), ...parts })
