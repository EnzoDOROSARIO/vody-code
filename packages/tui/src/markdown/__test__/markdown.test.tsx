import { expect, test } from 'bun:test'
import { renderToString } from 'ink'

import { BOLD, CYAN, DIM, ITALIC, STRIKETHROUGH, UNDERLINE, colourful } from '#__test__/testing.ts'
import { blocks } from '#markdown/blocks.ts'
import { Markdown } from '#markdown/index.tsx'

// What each block holds, with a list flattened back to its items, so a test can talk
// about the split without naming the shape the screen needs it in.
const texts = (markdown: string): ReadonlyArray<string> => {
  const out: Array<string> = []

  for (const block of blocks(markdown)) {
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

test('a message is split at its own block boundaries', () => {
  expect(texts('One.\n\nTwo.\n\nThree.')).toEqual(['One.', 'Two.', 'Three.'])
})

// The property the whole split rests on: a construct the model has not finished lands in
// the last block and nowhere else, so the blocks before it are settled and can be left
// alone. This is what a streamed reply will lean on.
test('an unclosed fence is the last block, and keeps what came before it intact', () => {
  const shown = texts('Here you go:\n\n```ts\nconst a = 1\nconst b = 2')

  expect(shown).toHaveLength(2)
  expect(shown[0]).toBe('Here you go:')
  expect(shown[1]).toContain('const a = 1')
  expect(shown[1]).toContain('const b = 2')
})

test('a closed fence ends where it closes, and the prose after it is its own block', () => {
  expect(texts('```ts\nconst a = 1\n```\n\nDone.')).toEqual(['const a = 1', 'Done.'])
})

test('a table still missing rows is one block, not prose that will rearrange', () => {
  expect(texts('| a | b |\n| - | - |\n| 1 | 2')).toEqual(['a  b\n─  ─\n1  2'])
})

// The model writes `~` to mean "about" far more often than it means to strike anything
// out, so the tokenizer that reads the first as the second is turned off.
test('a tilde is left alone, and so is a pair of them', () => {
  // The bold is here to give the render something to paint: `colourful` reports a
  // terminal that came back bare, and bare is exactly what the tildes should be.
  const painted = colourful(<Markdown>{'**loud** about ~100ms and ~~kept~~'}</Markdown>)

  expect(painted).not.toContain(STRIKETHROUGH)
  expect(painted).toContain('~100ms')
  expect(painted).toContain('~~kept~~')
})

test('a heading is set apart by its depth', () => {
  const first = colourful(<Markdown>{'# Title'}</Markdown>)
  const second = colourful(<Markdown>{'## Section'}</Markdown>)

  expect(first).toContain(BOLD)
  expect(first).toContain(UNDERLINE)
  expect(second).toContain(BOLD)
  expect(second).not.toContain(UNDERLINE)
})

test('emphasis, code and a quotation each carry their own styling', () => {
  const quoted = colourful(<Markdown>{'> quoted'}</Markdown>)

  expect(colourful(<Markdown>{'**loud**'}</Markdown>)).toContain(BOLD)
  expect(colourful(<Markdown>{'*soft*'}</Markdown>)).toContain(ITALIC)
  expect(colourful(<Markdown>{'`code`'}</Markdown>)).toContain(CYAN)
  expect(quoted).toContain(DIM)
  expect(quoted).toContain(ITALIC)
})

test('a fence is dim rather than highlighted', () => {
  expect(colourful(<Markdown>{'```ts\nconst a = 1\n```'}</Markdown>)).toContain(DIM)
})

test('a link is shown as its words, with the address behind them', () => {
  expect(renderToString(<Markdown>{'[docs](https://example.com)'}</Markdown>)).toBe(
    'docs https://example.com',
  )
})

test('a link with nothing but its address says it once', () => {
  expect(renderToString(<Markdown>{'<https://example.com>'}</Markdown>)).toBe('https://example.com')
})

test('blocks are set apart by a blank line', () => {
  expect(renderToString(<Markdown>{'One.\n\nTwo.'}</Markdown>)).toBe('One.\n\nTwo.')
})

test('nothing to show renders nothing', () => {
  expect(renderToString(<Markdown>{''}</Markdown>)).toBe('')
  expect(blocks('')).toEqual([])
})

// A bullet list is the one block Ink lays out itself, because a wrapped item has to come
// back under its own text rather than under the marker.
test('a list item that wraps continues under its own marker', () => {
  expect(renderToString(<Markdown>{'- alpha beta gamma delta'}</Markdown>, { columns: 14 })).toBe(
    '• alpha beta\n  gamma delta',
  )
})

test('a nested list starts on its own line, indented under the item above', () => {
  expect(renderToString(<Markdown>{'- one\n  - deeper\n- two'}</Markdown>)).toBe(
    '• one\n  • deeper\n• two',
  )
})

// An item whose whole content is a nested list still has to draw its marker. That row is
// the one saying a list started here, so it is drawn however empty it is — leave it out
// and the nested list hangs under nothing, a step below a step that was never written.
//
// The two spellings reach it by different routes. An item broken across lines keeps a
// `space` token where its words would be, so something precedes the nested list; one
// written on a single line holds the nested list and nothing else, and is the only input
// that asks the renderer to invent the row.
test('an item that opens straight onto a nested list still draws its marker', () => {
  expect(renderToString(<Markdown>{'- - a\n  - b'}</Markdown>)).toBe('•\n  • a\n  • b')
  expect(renderToString(<Markdown>{'-\n  - deep'}</Markdown>)).toBe('•\n  • deep')
})

// An item with nothing in it at all reaches the same rule by the shortest route: marked
// hands the item over holding no tokens whatsoever, and the marker is still the whole of
// what a reader has to tell them a list started.
test('an item holding nothing is still a row of its own', () => {
  expect(renderToString(<Markdown>{'- '}</Markdown>)).toBe('•')
})

// The blank line marked splits a loose item on outlives the nested list it followed: the
// item ends on a `space` token and nothing else, which stacks to nothing. That is a gap
// in the source, not a row, so drawing it would open a blank line between two siblings.
test('a blank line closing an item after a nested list is not a row', () => {
  expect(renderToString(<Markdown>{'- a\n  - b\n\n\n- c'}</Markdown>)).toBe('• a\n  • b\n• c')
})

test('an ordered list counts from where it says, and leaves its items in one column', () => {
  expect(renderToString(<Markdown>{'9. nine\n10. ten'}</Markdown>)).toBe('9.  nine\n10. ten')
})

test('a quotation is barred down its left, every line of it', () => {
  expect(renderToString(<Markdown>{'> one\n> two'}</Markdown>)).toBe('│ one\n│ two')
})

// Once the colour is gone a table is rows of words: the weight on the header and the
// rule under it are what say it is a table at all, so they are asserted rather than
// left to the plain-text shape below.
test('a table is bold across its header and dim along its rule', () => {
  const painted = colourful(<Markdown>{'| a | b |\n| - | - |\n| 1 | 2 |'}</Markdown>)

  expect(painted).toContain(BOLD)
  expect(painted).toContain(DIM)
})

test('a table lines its columns up and honours the alignment it was given', () => {
  expect(
    renderToString(
      <Markdown>{'| name | n |\n| --- | ---: |\n| alpha | 1 |\n| b | 22 |'}</Markdown>,
    ),
  ).toBe('name    n\n─────  ──\nalpha   1\nb      22')
})

// A quotation and a loose item both hold whole paragraphs, which is the one place the
// inline join would put a list on the end of the sentence above it.
test('a list inside a quotation starts below the line it follows', () => {
  expect(renderToString(<Markdown>{'> notes:\n> - one\n>   - deep'}</Markdown>)).toBe(
    '│ notes:\n│ • one\n│   • deep',
  )
})

test('a list item holding two paragraphs keeps them on separate lines', () => {
  expect(renderToString(<Markdown>{'- first para\n\n  second para\n\n- next'}</Markdown>)).toBe(
    '• first para\n  second para\n• next',
  )
})

// A plan written as a checklist is one of the most common things the model sends, and
// marked hands the box over as a sibling of the item's words rather than as part of them.
test('a task list keeps its box beside the item rather than above it', () => {
  expect(renderToString(<Markdown>{'- [x] done\n- [ ] todo'}</Markdown>)).toBe(
    '• [x] done\n• [ ] todo',
  )
})

test('a task item still carries the emphasis inside it', () => {
  expect(renderToString(<Markdown>{'- [ ] fix **now**'}</Markdown>)).toBe('• [ ] fix now')
})

// A step that names its sub-points and then closes with a sentence is ordinary writing,
// and the closing sentence has to stay where it was written: a reader told to run
// something before the steps it follows is being told the wrong order, not merely shown
// the right one badly.
test('a sentence after a nested list stays after it', () => {
  expect(
    renderToString(
      <Markdown>{'1. Install:\n\n   - a\n   - b\n\n   Then run it.\n\n2. Done.'}</Markdown>,
    ),
  ).toBe('1. Install:\n  • a\n  • b\n   Then run it.\n2. Done.')
})

test('a quoted item that runs to two paragraphs keeps them under its own words', () => {
  expect(renderToString(<Markdown>{'> - first para\n>\n>   second para'}</Markdown>)).toBe(
    '│ • first para\n│   second para',
  )
})

test('a quoted item hangs by the width of its number, not by one space', () => {
  expect(renderToString(<Markdown>{'> 10. ten\n>\n>     more'}</Markdown>)).toBe(
    '│ 10. ten\n│     more',
  )
})

// The bar sits in a column of its own so that a quotation wider than the window wraps
// into the space beside it. One `<Text>` holding both would put the rest of the line back
// at column zero, where nothing tells it apart from the prose around the quotation.
test('a quotation too wide for the window wraps clear of its bar', () => {
  expect(
    renderToString(<Markdown>{'> one two three four\n> last'}</Markdown>, { columns: 12 }),
  ).toBe('│ one two\n  three four\n│ last')
})

test('a rule is a divider of its own, between the blocks it parts', () => {
  expect(renderToString(<Markdown>{'above\n\n---\n\nbelow'}</Markdown>)).toBe(
    `above\n\n${'─'.repeat(24)}\n\nbelow`,
  )
})

test('an image is named rather than drawn', () => {
  const markdown = '![alt text](https://e.com/a.png)'

  expect(renderToString(<Markdown>{markdown}</Markdown>)).toBe('[alt text]')
  expect(colourful(<Markdown>{markdown}</Markdown>)).toContain(DIM)
})

test('a hard break puts the rest on the next line', () => {
  expect(renderToString(<Markdown>{'one  \ntwo'}</Markdown>)).toBe('one\ntwo')
})

test('an escaped star is the star, not emphasis', () => {
  expect(renderToString(<Markdown>{'a \\*not em\\* b'}</Markdown>)).toBe('a *not em* b')
})

// A link definition is the address the reference above resolves against. It has nothing
// to say on its own, so it must not arrive as a block of its own either.
test('a link definition is spent on the link and never shown', () => {
  expect(texts('[text][ref]\n\n[ref]: https://example.com')).toEqual(['text https://example.com'])
})

test('a heading below the second is quieter still', () => {
  const third = colourful(<Markdown>{'### Deep'}</Markdown>)

  expect(third).toContain(BOLD)
  expect(third).toContain(DIM)
  expect(third).not.toContain(UNDERLINE)
})

test('a centred column sits its cells in the middle of the width they share', () => {
  expect(renderToString(<Markdown>{'| a | b |\n| :-: | :-: |\n| 1 | 22222 |'}</Markdown>)).toBe(
    'a    b\n─  ─────\n1  22222',
  )
})

// A column is as wide as the room its cells take on screen, which is not how many
// characters they hold: a CJK glyph is one character and two columns, so measuring the
// string would leave every row below the widest cell short by the difference.
test('a column is measured in the space it takes on screen, not in characters', () => {
  expect(
    renderToString(
      <Markdown>{'| name | n |\n| --- | --- |\n| 日本語 | 1 |\n| ab | 2 |'}</Markdown>,
    ),
  ).toBe('name    n\n──────  ─\n日本語  1\nab      2')
})

test('an emoji is two columns wide, however many characters it is written with', () => {
  expect(
    renderToString(<Markdown>{'| x | y |\n| --- | --- |\n| 🎉 | 1 |\n| ab | 2 |'}</Markdown>),
  ).toBe('x   y\n──  ─\n🎉  1\nab  2')
})

// A top-level quotation is handed to the screen unbarred, so the bars a reader sees on
// it are Ink's. A quotation nested inside one has no column of its own to take, so it
// arrives as a finished string with its bar already written in — the one place the
// blockquote arm of the formatter draws rather than defers.
test('a quotation inside a quotation carries a bar of its own', () => {
  expect(renderToString(<Markdown>{'> outer\n>\n> > inner quote'}</Markdown>)).toBe(
    '│ outer\n│ │ inner quote',
  )
})

// A quotation with a column of its own is barred by Ink, which is what the render tests
// above cover. One inside a list item has no column to take, so its bar and its slant
// come from the blockquote arm instead — `Listed` styles nothing itself.
test('a quotation inside a list item carries its own bar and slant', () => {
  const painted = colourful(<Markdown>{'- outer\n  > quoted in list'}</Markdown>)

  expect(painted).toContain(DIM)
  expect(painted).toContain(ITALIC)
})

// A terminal has no HTML to render. Stripping the tags would drop whatever the model
// meant literally, so the markup is shown as written wherever it turns up.
test('markup is shown as written, tags and all', () => {
  expect(renderToString(<Markdown>{'<div>hi</div>'}</Markdown>)).toBe('<div>hi</div>')
  expect(renderToString(<Markdown>{'a <b>bold</b> c'}</Markdown>)).toBe('a <b>bold</b> c')
})
