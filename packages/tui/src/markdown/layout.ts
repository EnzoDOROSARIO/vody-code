import chalk from 'chalk'
import stringWidth from 'string-width'

import { casesHandled } from '../defects.ts'
import { wrapped } from '../wrapping.ts'
import { blocks } from './blocks.ts'
import { BAR, INDENT } from './style.ts'

/**
 * One row of a message laid out to a window: its words, or the blank row between two
 * blocks. A gap belongs to no block and carries no styling; the shell paints nothing
 * where it lands.
 */
export type MessageRow = { readonly text: string; readonly type: 'text' } | { readonly type: 'gap' }

/**
 * Lays a message's markdown out to the rows a window `columns` wide would paint: a blank
 * row between blocks, a list's continuation under its own words, a quotation barred down
 * its left with the words wrapping clear of the bar. The block strings already carry
 * their styling, so the shell has only to paint them.
 */
export const layout = (markdown: string, columns: number): ReadonlyArray<MessageRow> => {
  const laid: Array<MessageRow> = []

  blocks(markdown).forEach((block, index) => {
    if (index > 0) {
      laid.push({ type: 'gap' })
    }

    switch (block.kind) {
      case 'text': {
        for (const row of wrapped(block.text, columns)) {
          laid.push({ text: row, type: 'text' })
        }

        return
      }

      case 'list': {
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

      case 'quote': {
        for (const line of block.text.split('\n')) {
          wrapped(chalk.italic(line), columns - 2).forEach((row, at) => {
            const lead = at === 0 ? chalk.dim(`${BAR} `) : '  '

            laid.push({ text: (lead + row).trimEnd(), type: 'text' })
          })
        }

        return
      }

      // Stryker disable next-line ConditionalExpression: every Block kind has an arm above, so this one is reached only by a value the type rules out, and no test can build one without an assertion
      // Stryker disable next-line CallExpression: every Block kind has an arm above, so the call is never reached
      default:
        casesHandled(block)
    }
  })

  return laid
}
