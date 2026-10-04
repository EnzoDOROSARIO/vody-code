import { expect, it } from '@effect/vitest'

import {
  BOLD,
  CYAN,
  DIM,
  ITALIC,
  STRIKETHROUGH,
  UNDERLINE,
  painted,
  unpainted,
} from '#__test__/testing.ts'
import { blocks } from '#markdown/blocks.ts'
import { layout } from '#markdown/layout.ts'

// The layout's rows as the lines a reader sees: a gap is the blank line between two
// blocks. The expectations below are the look the old element render drew, kept as the
// look to preserve.
const drawn = (markdown: string, columns = 80): string =>
  layout(markdown, columns)
    .map((row) => (row.type === 'gap' ? '' : row.text))
    .join('\n')

const bare = (markdown: string, columns = 80): string => unpainted(() => drawn(markdown, columns))

const styled = (markdown: string, columns = 80): string => painted(() => drawn(markdown, columns))

// What each block holds, with a list flattened back to its items, so a test can talk
// about the split without naming the shape the screen needs it in.
const texts = (markdown: string): ReadonlyArray<string> => {
  const out: Array<string> = []

  for (const block of unpainted(() => blocks(markdown))) {
    if (block.kind === 'list') {
      const items: Array<string> = []

      for (const item of block.items) {
        items.push(item.text)
      }

      out.push(items.join('\n'))
      continue
    }

    out.push(block.text)
  }

  return out
}

// The two arms of a laid-out message are its contract with the frame: a `gap` paints
// nothing, and everything else is a `text` row. The look below joins those rows; this
// pins the shape the frame reads.
it('a row names whether it is words or a gap', () => {
  expect(unpainted(() => layout('One.', 80))).toEqual([{ text: 'One.', type: 'text' }])
  expect(unpainted(() => layout('- one', 80))).toEqual([{ text: '• one', type: 'text' }])
  expect(unpainted(() => layout('> one', 80))).toEqual([{ text: '│ one', type: 'text' }])
  expect(unpainted(() => layout('One.\n\nTwo.', 80))).toEqual([
    { text: 'One.', type: 'text' },
    { type: 'gap' },
    { text: 'Two.', type: 'text' },
  ])
})

// The split's kinds are what the layout reads to choose an arm, so they are pinned here
// the way the look is below: a list carries its items, a quotation its unbarred words,
// and a paragraph is text.
it('a block names whether it is text, a list, or a quotation', () => {
  expect(unpainted(() => blocks('One.'))).toEqual([{ kind: 'text', text: 'One.' }])
  expect(unpainted(() => blocks('- one'))).toEqual([
    { items: [{ depth: 0, marker: '•', text: 'one' }], kind: 'list' },
  ])
  expect(unpainted(() => blocks('> one'))).toEqual([{ kind: 'quote', text: 'one' }])
})

it('a message is split at its own block boundaries', () => {
  expect(texts('One.\n\nTwo.\n\nThree.')).toEqual(['One.', 'Two.', 'Three.'])
})

// The property the whole split rests on: a construct the model has not finished lands in
// the last block and nowhere else, so the blocks before it are settled and can be left
// alone. This is what a streamed reply will lean on.
it('an unclosed fence is the last block, and keeps what came before it intact', () => {
  const shown = texts('Here you go:\n\n```ts\nconst a = 1\nconst b = 2')

  expect(shown).toHaveLength(2)
  expect(shown[0]).toBe('Here you go:')
  expect(shown[1]).toContain('const a = 1')
  expect(shown[1]).toContain('const b = 2')
})

it('a closed fence ends where it closes, and the prose after it is its own block', () => {
  expect(texts('```ts\nconst a = 1\n```\n\nDone.')).toEqual(['const a = 1', 'Done.'])
})

it('a table still missing rows is one block, not prose that will rearrange', () => {
  expect(texts('| a | b |\n| - | - |\n| 1 | 2')).toEqual(['a  b\n─  ─\n1  2'])
})

// The model writes `~` to mean "about" far more often than it means to strike anything
// out, so the tokenizer that reads the first as the second is turned off.
it('a tilde is left alone, and so is a pair of them', () => {
  // The bold is here to give the render something to paint: `painted` reports a
  // terminal that came back bare, and bare is exactly what the tildes should be.
  const shown = styled('**loud** about ~100ms and ~~kept~~')

  expect(shown).not.toContain(STRIKETHROUGH)
  expect(shown).toContain('~100ms')
  expect(shown).toContain('~~kept~~')
})

// With that tokenizer on, the whole of `~~**bold**~~` is one token this module does not
// draw, and a token it does not draw falls through to its raw text — tildes, asterisks
// and all. Off, the tildes are prose and the emphasis between them is still emphasis.
it('a pair of tildes does not swallow the markup between them', () => {
  const shown = styled('**loud** and ~~**bold**~~')

  expect(shown).toContain(`${BOLD}bold`)
  expect(shown).toContain('~~')
  expect(shown).not.toContain('**bold**')
})

it('a heading is set apart by its depth', () => {
  const first = styled('# Title')
  const second = styled('## Section')

  expect(first).toContain(BOLD)
  expect(first).toContain(UNDERLINE)
  expect(second).toContain(BOLD)
  expect(second).not.toContain(UNDERLINE)
})

it('emphasis, code and a quotation each carry their own styling', () => {
  const quoted = styled('> quoted')

  expect(styled('**loud**')).toContain(BOLD)
  expect(styled('*soft*')).toContain(ITALIC)
  expect(styled('`code`')).toContain(CYAN)
  expect(quoted).toContain(DIM)
  expect(quoted).toContain(ITALIC)
})

it('a fence is dim rather than highlighted', () => {
  expect(styled('```ts\nconst a = 1\n```')).toContain(DIM)
})

it('a link is shown as its words, with the address behind them', () => {
  expect(bare('[docs](https://example.com)')).toBe('docs https://example.com')
})

it('a link with nothing but its address says it once', () => {
  expect(bare('<https://example.com>')).toBe('https://example.com')
})

it('blocks are set apart by a blank line', () => {
  expect(bare('One.\n\nTwo.')).toBe('One.\n\nTwo.')
})

it('nothing to show renders nothing', () => {
  expect(bare('')).toBe('')
  expect(blocks('')).toEqual([])
})

// A bullet list is the one block the layout draws itself, because a wrapped item has to
// come back under its own text rather than under the marker.
it('a list item that wraps continues under its own marker', () => {
  expect(bare('- alpha beta gamma delta', 14)).toBe('• alpha beta\n  gamma delta')
})

it('a nested list starts on its own line, indented under the item above', () => {
  expect(bare('- one\n  - deeper\n- two')).toBe('• one\n  • deeper\n• two')
})

// An item whose whole content is a nested list still has to draw its marker. That row is
// the one saying a list started here, so it is drawn however empty it is — leave it out
// and the nested list hangs under nothing, a step below a step that was never written.
//
// The two spellings reach it by different routes. An item broken across lines keeps a
// `space` token where its words would be, so something precedes the nested list; one
// written on a single line holds the nested list and nothing else, and is the only input
// that asks the renderer to invent the row.
it('an item that opens straight onto a nested list still draws its marker', () => {
  expect(bare('- - a\n  - b')).toBe('•\n  • a\n  • b')
  expect(bare('-\n  - deep')).toBe('•\n  • deep')
})

// An item with nothing in it at all reaches the same rule by the shortest route: marked
// hands the item over holding no tokens whatsoever, and the marker is still the whole of
// what a reader has to tell them a list started.
it('an item holding nothing is still a row of its own', () => {
  expect(bare('- ')).toBe('•')
})

// The blank line marked splits a loose item on outlives the nested list it followed: the
// item ends on a `space` token and nothing else, which stacks to nothing. That is a gap
// in the source, not a row, so drawing it would open a blank line between two siblings.
it('a blank line closing an item after a nested list is not a row', () => {
  expect(bare('- a\n  - b\n\n\n- c')).toBe('• a\n  • b\n• c')
})

it('an ordered list counts from where it says, and leaves its items in one column', () => {
  expect(bare('9. nine\n10. ten')).toBe('9.  nine\n10. ten')
})

it('a quotation is barred down its left, every line of it', () => {
  expect(bare('> one\n> two')).toBe('│ one\n│ two')
})

// Once the colour is gone a table is rows of words: the weight on the header and the
// rule under it are what say it is a table at all, so they are asserted rather than
// left to the plain-text shape below.
it('a table is bold across its header and dim along its rule', () => {
  const shown = styled('| a | b |\n| - | - |\n| 1 | 2 |')

  expect(shown).toContain(BOLD)
  expect(shown).toContain(DIM)
})

it('a table lines its columns up and honours the alignment it was given', () => {
  expect(bare('| name | n |\n| --- | ---: |\n| alpha | 1 |\n| b | 22 |')).toBe(
    'name    n\n─────  ──\nalpha   1\nb      22',
  )
})

// A quotation and a loose item both hold whole paragraphs, which is the one place the
// inline join would put a list on the end of the sentence above it.
it('a list inside a quotation starts below the line it follows', () => {
  expect(bare('> notes:\n> - one\n>   - deep')).toBe('│ notes:\n│ • one\n│   • deep')
})

it('a list item holding two paragraphs keeps them on separate lines', () => {
  expect(bare('- first para\n\n  second para\n\n- next')).toBe(
    '• first para\n  second para\n• next',
  )
})

// A plan written as a checklist is one of the most common things the model sends, and
// marked hands the box over as a sibling of the item's words rather than as part of them.
it('a task list keeps its box beside the item rather than above it', () => {
  expect(bare('- [x] done\n- [ ] todo')).toBe('• [x] done\n• [ ] todo')
})

it('a task item still carries the emphasis inside it', () => {
  expect(bare('- [ ] fix **now**')).toBe('• [ ] fix now')
})

// A step that names its sub-points and then closes with a sentence is ordinary writing,
// and the closing sentence has to stay where it was written: a reader told to run
// something before the steps it follows is being told the wrong order, not merely shown
// the right one badly.
it('a sentence after a nested list stays after it', () => {
  expect(bare('1. Install:\n\n   - a\n   - b\n\n   Then run it.\n\n2. Done.')).toBe(
    '1. Install:\n  • a\n  • b\n   Then run it.\n2. Done.',
  )
})

it('a quoted item that runs to two paragraphs keeps them under its own words', () => {
  expect(bare('> - first para\n>\n>   second para')).toBe('│ • first para\n│   second para')
})

it('a quoted item hangs by the width of its number, not by one space', () => {
  expect(bare('> 10. ten\n>\n>     more')).toBe('│ 10. ten\n│     more')
})

// The bar sits in a column of its own so that a quotation wider than the window wraps
// into the space beside it. One row holding the bar and the words together would put the
// rest of the line back at column zero, where nothing tells it apart from the prose
// around the quotation.
it('a quotation too wide for the window wraps clear of its bar', () => {
  expect(bare('> one two three four\n> last', 12)).toBe('│ one two\n  three four\n│ last')
})

it('a rule is a divider of its own, between the blocks it parts', () => {
  expect(bare('above\n\n---\n\nbelow')).toBe(`above\n\n${'─'.repeat(24)}\n\nbelow`)
})

it('an image is named rather than drawn', () => {
  const markdown = '![alt text](https://e.com/a.png)'

  expect(bare(markdown)).toBe('[alt text]')
  expect(styled(markdown)).toContain(DIM)
})

it('a hard break puts the rest on the next line', () => {
  expect(bare('one  \ntwo')).toBe('one\ntwo')
})

it('an escaped star is the star, not emphasis', () => {
  expect(bare('a \\*not em\\* b')).toBe('a *not em* b')
})

// A link definition is the address the reference above resolves against. It has nothing
// to say on its own, so it must not arrive as a block of its own either.
it('a link definition is spent on the link and never shown', () => {
  expect(texts('[text][ref]\n\n[ref]: https://example.com')).toEqual(['text https://example.com'])
})

it('a heading below the second is quieter still', () => {
  const third = styled('### Deep')

  expect(third).toContain(BOLD)
  expect(third).toContain(DIM)
  expect(third).not.toContain(UNDERLINE)
})

it('a centred column sits its cells in the middle of the width they share', () => {
  expect(bare('| a | b |\n| :-: | :-: |\n| 1 | 22222 |')).toBe('a    b\n─  ─────\n1  22222')
})

// A column is as wide as the room its cells take on screen, which is not how many
// characters they hold: a CJK glyph is one character and two columns, so measuring the
// string would leave every row below the widest cell short by the difference.
it('a column is measured in the space it takes on screen, not in characters', () => {
  expect(bare('| name | n |\n| --- | --- |\n| 日本語 | 1 |\n| ab | 2 |')).toBe(
    'name    n\n──────  ─\n日本語  1\nab      2',
  )
})

it('an emoji is two columns wide, however many characters it is written with', () => {
  expect(bare('| x | y |\n| --- | --- |\n| 🎉 | 1 |\n| ab | 2 |')).toBe(
    'x   y\n──  ─\n🎉  1\nab  2',
  )
})

// A top-level quotation is handed to the layout unbarred, so the bars a reader sees on
// it are the layout's. A quotation nested inside one has no column of its own to take, so
// it arrives as a finished string with its bar already written in — the one place the
// blockquote arm of the formatter draws rather than defers.
it('a quotation inside a quotation carries a bar of its own', () => {
  expect(bare('> outer\n>\n> > inner quote')).toBe('│ outer\n│ │ inner quote')
})

// A quotation with a column of its own is barred by the layout, which is what the render
// tests above cover. One inside a list item has no column to take, so its bar and its
// slant come from the blockquote arm instead — the list layout styles nothing itself.
it('a quotation inside a list item carries its own bar and slant', () => {
  const shown = styled('- outer\n  > quoted in list')

  expect(shown).toContain(DIM)
  expect(shown).toContain(ITALIC)
})

// A terminal has no HTML to render. Stripping the tags would drop whatever the model
// meant literally, so the markup is shown as written wherever it turns up.
it('markup is shown as written, tags and all', () => {
  expect(bare('<div>hi</div>')).toBe('<div>hi</div>')
  expect(bare('a <b>bold</b> c')).toBe('a <b>bold</b> c')
})
