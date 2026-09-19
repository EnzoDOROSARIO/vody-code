import chalk from 'chalk'
import stringWidth from 'string-width'

import { RULE, pad } from './style.ts'

import type { Align } from './style.ts'

/**
 * Lays already-drawn cells out in columns.
 *
 * Columns are padded to their own content rather than fitted to the terminal, so a wide
 * table wraps the way a long paragraph does. Two spaces between columns and a dim rule
 * under the header carry the structure without box-drawing, which is what breaks when a
 * pre-sized table meets a narrower window.
 *
 * The cells arrive as strings because their printed width is the only thing this needs
 * to know about them. What they were before — a token, a link, an emoji — is the
 * caller's business, and the padding measures what the terminal will show either way.
 */
export const tabulate = (
  header: ReadonlyArray<string>,
  body: ReadonlyArray<ReadonlyArray<string>>,
  align: ReadonlyArray<Align>,
): string => {
  const widths: Array<number> = []

  for (const [index, cell] of header.entries()) {
    let width = stringWidth(cell)

    for (const row of body) {
      width = Math.max(width, stringWidth(row[index] ?? ''))
    }

    widths.push(width)
  }

  const line = (cells: ReadonlyArray<string>): string => {
    const padded: Array<string> = []

    for (const [index, width] of widths.entries()) {
      padded.push(pad(cells[index] ?? '', width, align[index] ?? null))
    }

    return padded.join('  ').trimEnd()
  }

  const divider: Array<string> = []

  for (const width of widths) {
    divider.push(chalk.dim(RULE.repeat(width)))
  }

  const rows = [line(header), divider.join('  ')]

  for (const cells of body) {
    rows.push(line(cells))
  }

  return rows.join('\n')
}
