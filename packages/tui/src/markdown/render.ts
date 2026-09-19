import chalk from 'chalk'
import { Match } from 'effect'
import stringWidth from 'string-width'

import { BAR, BULLET, INDENT, RULE, RULE_WIDTH, heading, pad } from './style.ts'
import { tabulate } from './table.ts'
import { listed, parsed } from './tokens.ts'

import type { Token, Tokens } from 'marked'
import type { Drawable } from './tokens.ts'

/**
 * One row of a list, already carrying the marker and the nesting it was found at.
 *
 * An item that resumes after a nested list is another row, and its marker is the blanks
 * the real one occupied, so the row lines up under the words it continues.
 */
export type Item = {
  readonly depth: number
  readonly marker: string
  readonly text: string
}

const inline = (tokens: ReadonlyArray<Token>): string => {
  let out = ''

  for (const token of tokens) {
    out += format(token)
  }

  return out
}

// Blocks stack, where the words inside one run together. A quotation and a loose list
// item both hold whole paragraphs, and joining those the inline way is what puts a list
// on the end of the sentence above it.
export const stacked = (tokens: ReadonlyArray<Token>): string => {
  const rows: Array<string> = []

  for (const token of tokens) {
    const text = format(token).trimEnd()

    if (text !== '') {
      rows.push(text)
    }
  }

  return rows.join('\n')
}

// The markers of one list are padded to a common width so that `9.` and `10.` leave
// their items starting in the same column.
const markers = (list: Tokens.List): ReadonlyArray<string> => {
  const first = list.start === '' ? 1 : list.start
  const drawn: Array<string> = []
  let width = 0

  for (const [index] of list.items.entries()) {
    const marker = list.ordered ? `${first + index}.` : BULLET

    width = Math.max(width, stringWidth(marker))
    drawn.push(marker)
  }

  const padded: Array<string> = []

  for (const marker of drawn) {
    padded.push(pad(marker, width, 'left'))
  }

  return padded
}

// A list flattens: a nested list is not drawn inside its parent item but follows it,
// carrying the depth that indents it. That keeps every item one row of the same shape,
// however deeply the model nested them.
//
// The item's own tokens are walked in the order they were written rather than gathered
// and emitted ahead of the nested lists, because a step that names its sub-points and
// then closes with a sentence is ordinary prose, and hoisting that sentence above the
// sub-points tells the reader to do things in an order the model did not write.
//
// A run that follows a nested list carries a marker of blanks the width of the real one,
// so it lines up under the words it continues instead of under the bullet.
//
// The depth is the walk's own business, which is why it is threaded here and not through
// the export below: no caller nests a list on purpose, they just hand over the one they
// were given.
const walk = (list: Tokens.List, depth: number): ReadonlyArray<Item> => {
  const drawn = markers(list)
  const items: Array<Item> = []

  for (const [index, item] of list.items.entries()) {
    // marked emits a task box as a sibling of the item's words rather than as part of
    // them, so stacking it with the rest is what puts `[x]` on a row of its own. It
    // joins the marker, which also keeps a wrapped item clear of the box.
    const [head] = item.tokens
    const ticked = head !== undefined && parsed(head) && head.type === 'checkbox'
    const point = drawn[index] ?? BULLET
    const marker = ticked ? `${point} ${format(head)}` : point
    const under = ' '.repeat(stringWidth(marker))
    const tokens = ticked ? item.tokens.slice(1) : item.tokens

    let pending: Array<Token> = []
    let rows = 0

    const flush = (): void => {
      const text = stacked(pending)

      pending = []

      if (rows > 0 && text === '') {
        return
      }

      items.push({ depth, marker: rows === 0 ? marker : under, text })
      rows += 1
    }

    for (const token of tokens) {
      if (listed(token)) {
        flush()
        items.push(...walk(token, depth + 1))
        continue
      }

      pending.push(token)
    }

    flush()
  }

  return items
}

/** Flattens a list into the rows it is drawn as, outermost first. */
export const itemize = (list: Tokens.List): ReadonlyArray<Item> => walk(list, 0)

// A list reached through here is one the screen cannot lay out itself — quoted, or
// inside another block — so it is drawn as text, marker and all. Such a list wraps the
// way any other line does, without the hanging indent `Listed` gives a top-level one.
const quoted = (list: Tokens.List): string => {
  const rows: Array<string> = []

  for (const item of itemize(list)) {
    const under = ' '.repeat(item.depth * INDENT)
    // The rest of an item hangs under its own words, so the indent is the marker's width
    // and not a single space: a bullet takes two columns and `10.` takes four, and a line
    // set one column in reads as a new item rather than as more of the one above.
    const hang = ' '.repeat(under.length + stringWidth(item.marker) + 1)

    rows.push(`${under}${item.marker} ${item.text.split('\n').join(`\n${hang}`)}`)
  }

  return rows.join('\n')
}

// The cells are drawn here and laid out there. `tabulate` needs their printed width and
// nothing else about them, so it takes strings and never learns what a token is.
const tabled = (table: Tokens.Table): string => {
  const header: Array<string> = []

  for (const cell of table.header) {
    header.push(chalk.bold(inline(cell.tokens)))
  }

  const body: Array<Array<string>> = []

  for (const row of table.rows) {
    const cells: Array<string> = []

    for (const cell of row) {
      cells.push(inline(cell.tokens))
    }

    body.push(cells)
  }

  return tabulate(header, body, table.align)
}

// One arm per token marked can hand over, keyed by the `type` that picks it.
//
// A switch answers the same question, but it answers it as twenty-odd branches sharing
// one body: every measure of complexity reads that as risk, and a reader who wants to
// know how one token is drawn has to scan past the rest. Here the arms are data.
// `discriminatorsExhaustive` demands exactly one key per member of `Drawable` and
// refuses any key that is not one, so a token type marked adds, or one this module
// stops drawing, is an error against this table rather than a branch that quietly
// never runs again. `DRAWN` in `tokens.ts` is annotated against the same union for the
// same reason: `parsed` is what decides whether a token reaches this table at all, so
// the two have to name the same set, and only the compiler can be trusted to say so.
const draw = Match.type<Drawable>().pipe(
  Match.discriminatorsExhaustive('type')({
    blockquote: (token) =>
      stacked(token.tokens)
        .split('\n')
        .map((line) => `${chalk.dim(BAR)} ${chalk.italic(line)}`)
        .join('\n'),
    br: () => '\n',
    checkbox: (token) => (token.checked ? '[x]' : '[ ]'),
    // A fence is dim and unhighlighted on purpose. Highlighting wants a language span
    // the fence only has once it closes, and re-running a highlighter over a block that
    // is still growing costs more than the colour is worth.
    code: (token) => chalk.dim(token.text),
    codespan: (token) => chalk.cyan(token.text),
    // A link definition is the reference the links resolve against, never shown itself.
    def: () => '',
    em: (token) => chalk.italic(inline(token.tokens)),
    escape: (token) => token.text,
    heading: (token) => heading(inline(token.tokens), token.depth),
    hr: () => chalk.dim(RULE.repeat(RULE_WIDTH)),
    // A terminal has no HTML to render, so the markup is shown as written, tags and all.
    // Stripping the tags would drop content whenever the model meant the angle brackets
    // literally, and a `<div>` on the screen at least says where its words came from.
    html: (token) => token.text,
    image: (token) => chalk.dim(`[${token.text}]`),
    link: (token) => {
      const text = inline(token.tokens)

      return text === token.href ? chalk.dim(token.href) : `${text} ${chalk.dim(token.href)}`
    },
    list: quoted,
    paragraph: (token) => inline(token.tokens),
    // Blank lines between blocks; the gap between them is the renderer's to place.
    space: () => '',
    strong: (token) => chalk.bold(inline(token.tokens)),
    table: tabled,
    text: (token) => (token.tokens === undefined ? token.text : inline(token.tokens)),
  }),
)

// A token from a marked plugin this module was never taught to draw keeps its own text,
// which is the markdown the model wrote and the least wrong thing to put on the screen.
export const format = (token: Token): string => (parsed(token) ? draw(token) : token.raw)
