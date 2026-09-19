import chalk from 'chalk'
import stringWidth from 'string-width'

/** Which edge of its column a table cell is pinned to, `null` being the default. */
export type Align = 'center' | 'left' | 'right' | null

export const BAR = '│'

export const RULE = '─'

export const BULLET = '•'

export const INDENT = 2

// A horizontal rule has no width to fill: this renderer formats tokens into strings and
// never learns how wide the terminal is. A short rule reads as a divider at any width,
// where one guessed too long would wrap and arrive as two.
export const RULE_WIDTH = 24

export const pad = (cell: string, width: number, align: Align): string => {
  // Padding is measured against what the terminal shows, not what the string holds: a
  // formatted cell carries colour codes, and an emoji or a CJK glyph is two columns wide.
  const slack = Math.max(0, width - stringWidth(cell))

  if (align === 'right') {
    return `${' '.repeat(slack)}${cell}`
  }

  if (align === 'center') {
    const left = Math.floor(slack / 2)

    return `${' '.repeat(left)}${cell}${' '.repeat(slack - left)}`
  }

  return `${cell}${' '.repeat(slack)}`
}

export const heading = (text: string, depth: number): string => {
  if (depth === 1) {
    return chalk.bold.underline(text)
  }

  return depth === 2 ? chalk.bold(text) : chalk.bold.dim(text)
}
