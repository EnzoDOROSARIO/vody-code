import chalk from 'chalk'
import { Box, Text } from 'ink'
import { Marked } from 'marked'
import { memo } from 'react'
import stringWidth from 'string-width'

import { casesHandled } from './defects.ts'

import type { MarkedToken, Token, Tokens } from 'marked'
import type { ReactElement } from 'react'

/** Which edge of its column a table cell is pinned to, `null` being the default. */
type Align = 'center' | 'left' | 'right' | null

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

const BAR = '│'

const RULE = '─'

const BULLET = '•'

const INDENT = 2

// A horizontal rule has no width to fill: this module formats tokens into strings and
// never learns how wide the terminal is. A short rule reads as a divider at any width,
// where one guessed too long would wrap and arrive as two.
const RULE_WIDTH = 24

// `marked.use` mutates a module-global singleton that every other caller in the process
// shares, which is how two components with different options end up racing. An instance
// of its own keeps both changes below inside this module.
//
// Strikethrough is off because the model writes `~` far more often to mean "about" —
// `~100ms` — than it writes `~~` to strike something out, and the tokenizer reads the
// first as the second across the rest of the line.
const reader = new Marked({ gfm: true })

reader.use({ tokenizer: { del: () => undefined } })

// `Token` ends in `Tokens.Generic`, whose `type` is a bare `string` and whose index
// signature answers to any property name at all. That one member keeps a switch on
// `type` from narrowing to a single interface, so every case below would read its
// fields through the index signature rather than through the shape marked documents.
// Naming the types marked itself produces puts the union back; a plugin's own token,
// which this module has not been taught to draw, falls through to its raw text.
//
// `del` and `list_item` are left out, and `Drawable` drops them from the union to match.
// The strikethrough tokenizer is turned off above, so no `del` token is ever produced;
// and a list item is reached through its list's `items`, never through any token's
// `tokens`, so `format` is never handed one. An arm for either would be one no input
// can reach, and an arm no input reaches is one nothing can hold to its word.
const PARSED: ReadonlySet<string> = new Set([
  'blockquote',
  'br',
  'checkbox',
  'code',
  'codespan',
  'def',
  'em',
  'escape',
  'heading',
  'hr',
  'html',
  'image',
  'link',
  'list',
  'paragraph',
  'space',
  'strong',
  'table',
  'text',
])

/** A token this module draws: what marked produces, less the two it cannot hand over. */
type Drawable = Exclude<MarkedToken, Tokens.Del | Tokens.ListItem>

const parsed = (token: Token): token is Drawable => PARSED.has(token.type)

const listed = (token: Token): token is Tokens.List => parsed(token) && token.type === 'list'

const quotation = (token: Token): token is Tokens.Blockquote =>
  parsed(token) && token.type === 'blockquote'

const pad = (cell: string, width: number, align: Align): string => {
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

const heading = (text: string, depth: number): string => {
  if (depth === 1) {
    return chalk.bold.underline(text)
  }

  return depth === 2 ? chalk.bold(text) : chalk.bold.dim(text)
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
const stacked = (tokens: ReadonlyArray<Token>): string => {
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
const itemize = (list: Tokens.List, depth: number, into: Array<Item>): void => {
  const drawn = markers(list)

  for (const [index, item] of list.items.entries()) {
    // marked emits a task box as a sibling of the item's words rather than as part of
    // them, so stacking it with the rest is what puts `[x]` on a row of its own. It
    // joins the marker, which also keeps a wrapped item clear of the box.
    const [head] = item.tokens
    const ticked = head !== undefined && parsed(head) && head.type === 'checkbox'
    const marker = ticked ? `${drawn[index] ?? BULLET} ${format(head)}` : (drawn[index] ?? BULLET)
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

      into.push({ depth, marker: rows === 0 ? marker : under, text })
      rows += 1
    }

    for (const token of tokens) {
      if (listed(token)) {
        flush()
        itemize(token, depth + 1, into)
        continue
      }

      pending.push(token)
    }

    flush()
  }
}

// Columns are padded to their own content rather than fitted to the terminal, so a wide
// table wraps the way a long paragraph does. Two spaces between columns and a dim rule
// under the header carry the structure without box-drawing, which is what breaks when a
// pre-sized table meets a narrower window.
const tabulate = (table: Tokens.Table): string => {
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
      padded.push(pad(cells[index] ?? '', width, table.align[index] ?? null))
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

// A list reached through here is one the screen cannot lay out itself — quoted, or
// inside another block — so it is drawn as text, marker and all. Such a list wraps the
// way any other line does, without the hanging indent `Listed` gives a top-level one.
const quoted = (list: Tokens.List): string => {
  const items: Array<Item> = []

  itemize(list, 0, items)

  const rows: Array<string> = []

  for (const item of items) {
    const under = ' '.repeat(item.depth * INDENT)
    // The rest of an item hangs under its own words, so the indent is the marker's width
    // and not a single space: a bullet takes two columns and `10.` takes four, and a line
    // set one column in reads as a new item rather than as more of the one above.
    const hang = ' '.repeat(under.length + stringWidth(item.marker) + 1)

    rows.push(`${under}${item.marker} ${item.text.split('\n').join(`\n${hang}`)}`)
  }

  return rows.join('\n')
}

const format = (token: Token): string => {
  if (!parsed(token)) {
    return token.raw
  }

  switch (token.type) {
    case 'blockquote':
      return stacked(token.tokens)
        .split('\n')
        .map((line) => `${chalk.dim(BAR)} ${chalk.italic(line)}`)
        .join('\n')
    case 'br':
      return '\n'
    case 'checkbox':
      return token.checked ? '[x]' : '[ ]'
    // A fence is dim and unhighlighted on purpose. Highlighting wants a language span
    // the fence only has once it closes, and re-running a highlighter over a block that
    // is still growing costs more than the colour is worth.
    case 'code':
      return chalk.dim(token.text)
    case 'codespan':
      return chalk.cyan(token.text)
    case 'def':
      // A link definition is the reference the links resolve against, never shown itself.
      return ''
    case 'em':
      return chalk.italic(inline(token.tokens))
    case 'escape':
      return token.text
    case 'heading':
      return heading(inline(token.tokens), token.depth)
    case 'hr':
      return chalk.dim(RULE.repeat(RULE_WIDTH))
    // A terminal has no HTML to render, so the markup is shown as written, tags and all.
    // Stripping the tags would drop content whenever the model meant the angle brackets
    // literally, and a `<div>` on the screen at least says where its words came from.
    case 'html':
      return token.text
    case 'image':
      return chalk.dim(`[${token.text}]`)
    case 'link': {
      const text = inline(token.tokens)

      return text === token.href ? chalk.dim(token.href) : `${text} ${chalk.dim(token.href)}`
    }

    case 'list':
      return quoted(token)
    case 'paragraph':
      return inline(token.tokens)
    case 'space':
      // Blank lines between blocks; the gap between them is the renderer's to place.
      return ''
    case 'strong':
      return chalk.bold(inline(token.tokens))
    case 'table':
      return tabulate(token)
    case 'text':
      return token.tokens === undefined ? token.text : inline(token.tokens)
    default:
      return casesHandled(token)
  }
}

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
      const items: Array<Item> = []

      itemize(token, 0, items)
      shown.push({ items, kind: 'list' })
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

// The marker sits in a box of its own so the item beside it is what wraps, and wraps
// into the column the marker left free. One `<Text>` holding both would put the second
// line back under the marker instead.
const Listed = ({ items }: { readonly items: ReadonlyArray<Item> }): ReactElement => (
  <Box flexDirection="column">
    {items.map((item, index) => (
      // oxlint-disable-next-line react/no-array-index-key -- items are positional
      <Box key={index} paddingLeft={item.depth * INDENT}>
        <Text>{`${item.marker} `}</Text>
        <Box flexGrow={1}>
          <Text>{item.text}</Text>
        </Box>
      </Box>
    ))}
  </Box>
)

// Each line of a quotation is a row of its own, with the bar in a box beside it, for the
// same reason a list item is: one `<Text>` holding the bars and the words together would
// wrap a long line back under the bar, and a quotation wider than the window would arrive
// with its mark on the first row and nothing to tell the rest apart from ordinary prose.
const Quoted = ({ text }: { readonly text: string }): ReactElement => (
  <Box flexDirection="column">
    {text.split('\n').map((line, index) => (
      // oxlint-disable-next-line react/no-array-index-key -- lines are positional
      <Box key={index}>
        <Text dimColor>{`${BAR} `}</Text>
        <Box flexGrow={1}>
          <Text italic>{line}</Text>
        </Box>
      </Box>
    ))}
  </Box>
)

// Which of the three shapes a block is drawn in. Only a paragraph of text is finished
// enough to hand Ink as one string; the other two keep a column to themselves.
const Drawn = ({ block }: { readonly block: Block }): ReactElement => {
  if (block.kind === 'list') {
    return <Listed items={block.items} />
  }

  if (block.kind === 'quote') {
    return <Quoted text={block.text} />
  }

  return <Text>{block.text}</Text>
}

/**
 * Renders markdown as the terminal's own styling, one Ink element per block.
 *
 * A block to itself is what lets Ink measure against the real window, and it is the
 * seam a streamed reply needs later: the blocks before the last one are settled, and
 * only the last is still being written.
 *
 * Memoized because the transcript re-renders on every keystroke, and re-lexing every
 * message that has already been said is the cost that would come with it.
 */
export const Markdown = memo(function Markdown({
  children,
}: {
  readonly children: string
}): ReactElement | null {
  const shown = blocks(children)

  if (shown.length === 0) {
    return null
  }

  return (
    <Box flexDirection="column" gap={1}>
      {shown.map((block, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- blocks are positional
        <Drawn block={block} key={index} />
      ))}
    </Box>
  )
})
