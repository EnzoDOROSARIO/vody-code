import { Box, Text } from 'ink'
import { memo } from 'react'

import { blocks } from './blocks.ts'
import { BAR, INDENT } from './style.ts'

import type { ReactElement } from 'react'
import type { Block } from './blocks.ts'
import type { Item } from './render.ts'

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
