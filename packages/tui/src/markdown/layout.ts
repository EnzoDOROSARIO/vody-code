import chalk from 'chalk'
import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'

import { blocks } from './blocks.ts'
import { BAR, INDENT } from './style.ts'

/**
 * One row of a message laid out to a window: its words, or the blank row between two
 * blocks. A gap belongs to no block and carries no styling; the shell paints nothing
 * where it lands.
 */
export type Laid = { readonly text: string; readonly type: 'text' } | { readonly type: 'gap' }

// One source line to the rows the terminal would paint for it, wrapped the way Ink wraps
// (`ink/build/wrap-text.js`), so the frame lays the Transcript out to exactly the rows a
// mounted Ink would have drawn. Trailing whitespace is trimmed off each row because Ink
// trims it off every painted line; whitespace inside a styled span survives either way,
// since the escape after it stops the trim.
export const wrapped = (text: string, width: number): ReadonlyArray<string> =>
  wrapAnsi(text, Math.max(1, width), { hard: true, trim: false })
    .split('\n')
    .map((row) => row.trimEnd())

/**
 * Lays a message's markdown out to the rows a window `columns` wide would paint: a blank
 * row between blocks, a list's continuation under its own words, a quotation barred down
 * its left with the words wrapping clear of the bar. The block strings already carry
 * their styling, so the shell has only to paint them.
 */
export const layout = (markdown: string, columns: number): ReadonlyArray<Laid> => {
  const laid: Array<Laid> = []

  blocks(markdown).forEach((block, index) => {
    if (index > 0) {
      laid.push({ type: 'gap' })
    }

    if (block.kind === 'text') {
      for (const row of wrapped(block.text, columns)) {
        laid.push({ text: row, type: 'text' })
      }

      return
    }

    if (block.kind === 'list') {
      for (const item of block.items) {
        const indent = item.depth * INDENT
        const hang = indent + stringWidth(item.marker) + 1

        wrapped(item.text, columns - hang).forEach((row, at) => {
          const lead = at === 0 ? `${' '.repeat(indent)}${item.marker} ` : ' '.repeat(hang)

          // The composed row is trimmed the way Ink trims every painted line, so an item
          // whose marker is the whole row arrives as `•` and not as `• `.
          laid.push({ text: (lead + row).trimEnd(), type: 'text' })
        })
      }

      return
    }

    for (const line of block.text.split('\n')) {
      wrapped(chalk.italic(line), columns - 2).forEach((row, at) => {
        const lead = at === 0 ? chalk.dim(`${BAR} `) : '  '

        laid.push({ text: (lead + row).trimEnd(), type: 'text' })
      })
    }
  })

  return laid
}
