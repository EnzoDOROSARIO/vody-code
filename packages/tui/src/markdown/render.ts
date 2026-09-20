import chalk from 'chalk'
import { Array, Match } from 'effect'
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

const inline = (tokens: ReadonlyArray<Token>): string =>
  tokens.map((token) => format(token)).join('')

// Blocks stack, where the words inside one run together. A quotation and a loose list
// item both hold whole paragraphs, and joining those the inline way is what puts a list
// on the end of the sentence above it.
//
// Dropping the empty rows is a filter over a mapped value, and `flatMap` is the one way
// of writing that which survives: `.map().filter()` is the pair of passes
// `anti-slop/no-array-filter-map` rejects, and `Array.filterMap` wants every row wrapped
// in a `Result` to say what `!== ''` says here.
export const stacked = (tokens: ReadonlyArray<Token>): string =>
  tokens
    .flatMap((token) => {
      const text = format(token).trimEnd()

      return text === '' ? [] : [text]
    })
    .join('\n')

// The markers of one list are padded to a common width so that `9.` and `10.` leave
// their items starting in the same column.
const markers = (list: Tokens.List): ReadonlyArray<string> => {
  const first = list.start === '' ? 1 : list.start
  const drawn = list.items.map((_, index) => (list.ordered ? `${first + index}.` : BULLET))
  const width = drawn.reduce((widest, marker) => Math.max(widest, stringWidth(marker)), 0)

  return drawn.map((marker) => pad(marker, width, 'left'))
}

// The list a segment holds, where it is one of the nested ones. `segments` cuts those out
// one to a segment, so the first token settles it.
const nested = (segment: ReadonlyArray<Token>): Tokens.List | undefined => {
  const [token] = segment

  return token !== undefined && listed(token) ? token : undefined
}

// An item's tokens cut at every list nested inside it: a run of prose, the list that
// interrupted it, then whatever resumed below. Adjacency is the whole of the rule, so
// grouping on "neither of these two is a list" leaves each nested list a segment of its
// own and every stretch of prose whole — in the order they were written, which is what
// keeps the sentence that closes a step below the sub-points it closes.
const segments = (
  tokens: ReadonlyArray<Token>,
): Array.NonEmptyReadonlyArray<ReadonlyArray<Token>> => {
  if (!Array.isReadonlyArrayNonEmpty(tokens)) {
    return [[]]
  }

  const cut = Array.groupWith(tokens, (left, right) => !listed(left) && !listed(right))

  // The first segment is the row the marker is drawn on. An item that opens straight onto
  // a nested list has no words of its own to be that row, so it is given an empty one.
  return nested(Array.headNonEmpty(cut)) === undefined ? cut : [[], ...cut]
}

// A list flattens: a nested list is not drawn inside its parent item but follows it,
// carrying the depth that indents it. That keeps every item one row of the same shape,
// however deeply the model nested them.
//
// The depth is the walk's own business, which is why it is threaded here and not through
// the export below: no caller nests a list on purpose, they just hand over the one they
// were given.
const walk = (list: Tokens.List, depth: number): ReadonlyArray<Item> => {
  const drawn = markers(list)

  return list.items.flatMap((item, index) => {
    // marked emits a task box as a sibling of the item's words rather than as part of
    // them, so stacking it with the rest is what puts `[x]` on a row of its own. It
    // joins the marker, which also keeps a wrapped item clear of the box.
    const [box] = item.tokens
    const ticked = box !== undefined && parsed(box) && box.type === 'checkbox'
    const point = drawn[index] ?? BULLET
    const marker = ticked ? `${point} ${format(box)}` : point
    const under = ' '.repeat(stringWidth(marker))
    const [head, ...rest] = segments(ticked ? item.tokens.slice(1) : item.tokens)

    // The marker's row is drawn whatever it holds, empty words and all, because it is the
    // one row carrying the marker. Every row after it continues the item, so it takes
    // blanks the marker's width to line up under the words it continues rather than under
    // the bullet — and an empty one is dropped, since the blank line marked splits a loose
    // item on is a gap and not a row.
    return [
      { depth, marker, text: stacked(head) },
      ...rest.flatMap((segment) => {
        const inside = nested(segment)

        if (inside !== undefined) {
          return walk(inside, depth + 1)
        }

        const text = stacked(segment)

        return text === '' ? [] : [{ depth, marker: under, text }]
      }),
    ]
  })
}

/** Flattens a list into the rows it is drawn as, outermost first. */
export const itemize = (list: Tokens.List): ReadonlyArray<Item> => walk(list, 0)

// A list reached through here is one the screen cannot lay out itself — quoted, or
// inside another block — so it is drawn as text, marker and all. Such a list wraps the
// way any other line does, without the hanging indent `Listed` gives a top-level one.
const quoted = (list: Tokens.List): string =>
  itemize(list)
    .map((item) => {
      const under = ' '.repeat(item.depth * INDENT)
      // The rest of an item hangs under its own words, so the indent is the marker's width
      // and not a single space: a bullet takes two columns and `10.` takes four, and a line
      // set one column in reads as a new item rather than as more of the one above.
      const hang = ' '.repeat(under.length + stringWidth(item.marker) + 1)

      return `${under}${item.marker} ${item.text.split('\n').join(`\n${hang}`)}`
    })
    .join('\n')

// The cells are drawn here and laid out there. `tabulate` needs their printed width and
// nothing else about them, so it takes strings and never learns what a token is.
const tabled = (table: Tokens.Table): string =>
  tabulate(
    table.header.map((cell) => chalk.bold(inline(cell.tokens))),
    table.rows.map((row) => row.map((cell) => inline(cell.tokens))),
    table.align,
  )

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
