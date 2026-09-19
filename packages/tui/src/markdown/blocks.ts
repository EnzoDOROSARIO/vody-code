import { format, itemize, stacked } from './render.ts'
import { listed, quotation, reader } from './tokens.ts'

import type { Item } from './render.ts'

/**
 * One top-level piece of a message, in the form the screen needs it.
 *
 * A list and a quotation are the two blocks the terminal cannot be handed as a finished
 * string: both carry something in a column of its own — a marker, a bar — that Ink has
 * to be told about, or a line too long for the window wraps back underneath it. A
 * quotation's text arrives here unbarred for that reason.
 */
export type Block =
  | { readonly items: ReadonlyArray<Item>; readonly kind: 'list' }
  | { readonly kind: 'quote'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }

/**
 * Splits markdown into the blocks a transcript shows, each already styled for a terminal.
 *
 * The split is at marked's own top-level token boundaries, which is what makes it safe
 * on a half-written message: an unclosed fence lexes as one `code` token holding the
 * rest, so an incomplete construct is always the last block rather than something that
 * swallows the ones before it.
 */
export const blocks = (markdown: string): ReadonlyArray<Block> => {
  const shown: Array<Block> = []

  for (const token of reader.lexer(markdown)) {
    if (listed(token)) {
      shown.push({ items: itemize(token), kind: 'list' })
      continue
    }

    if (quotation(token)) {
      const said = stacked(token.tokens).trimEnd()

      if (said !== '') {
        shown.push({ kind: 'quote', text: said })
      }

      continue
    }

    const text = format(token).trimEnd()

    if (text !== '') {
      shown.push({ kind: 'text', text })
    }
  }

  return shown
}
