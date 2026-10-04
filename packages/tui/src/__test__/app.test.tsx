import { expect, it } from '@effect/vitest'

import { ScreenView } from '#app.tsx'
import {
  BOLD,
  CYAN,
  DIM,
  GREY_BACKGROUND,
  INVERSE,
  ITALIC,
  colourful,
  plain,
  screen,
} from './testing.ts'

import type { Screen } from '#frame.ts'

const VIEWPORT = { columns: 40, rows: 10 }

const bare = (state: Screen): ReadonlyArray<string> =>
  plain(<ScreenView screen={state} />, VIEWPORT.columns).split('\n')

const styled = (state: Screen): ReadonlyArray<string> =>
  colourful(<ScreenView screen={state} />, VIEWPORT.columns).split('\n')

// The idle Composer is the frame's content row: the chevron and the Draft, inside the
// border the shell draws, on the last rows of the screen.
it('the idle Composer is framed on the last rows, with the chevron and the Draft', () => {
  const lines = bare(screen({ draft: 'who am I' }, VIEWPORT))

  expect(lines.at(-3)).toBe(`┌${'─'.repeat(38)}┐`)
  expect(lines.at(-2)).toBe(`│> who am I${' '.repeat(28)}│`)
  expect(lines.at(-1)).toBe(`└${'─'.repeat(38)}┘`)
})

// The cursor is drawn, not the terminal's own: a reversed cell just after the Draft,
// where the next character lands.
it('the idle Composer draws its cursor just after the Draft', () => {
  const content = styled(screen({ draft: 'who am I' }, VIEWPORT)).at(-2) ?? ''

  expect(content).toContain(`who am I${INVERSE} `)
})

// A Draft longer than the row slides, so the end — where the next character lands —
// is always the part in view, with the cursor's cell still inside the frame.
it('a long Draft slides, so its end and the cursor stay in the frame', () => {
  const lines = bare(screen({ draft: 'abcdefghijklmnop' }, { columns: 12, rows: 6 }))

  expect(lines.at(-2)).toBe('│hijklmnop │')
})

// Locked the content row is a still ellipsis: dim, the way a tool's text is, but with
// no slab behind it and no chevron, so it reads as a face and not as a tool or the idle
// Composer.
it('the Locked face is a dim ellipsis, with no chevron and no slab', () => {
  const content = styled(screen({ locked: true }, VIEWPORT)).at(-2) ?? ''

  expect(content).toContain('…')
  expect(content).toContain(DIM)
  expect(content).not.toContain(GREY_BACKGROUND)
  expect(content).not.toContain('>')
  expect(content).not.toContain(INVERSE)
})

// A tool's output is a grey slab with dim text; the blank row above the call is a row
// of the frame painted by nobody, so the slab does not sit against the seam.
it('a tool is a grey slab, and the gap above it is bare', () => {
  const lines = styled(
    screen(
      {
        lines: [
          { source: 'you', text: '> run it' },
          { source: 'call', text: '$ echo hi' },
          { source: 'result', text: 'exit 0' },
        ],
      },
      VIEWPORT,
    ),
  )

  expect(lines[0]).toBe('> run it')
  expect(lines[1]).toBe('')
  expect(lines[2]).toContain(GREY_BACKGROUND)
  expect(lines[2]).toContain(DIM)
  expect(lines[3]).toContain(GREY_BACKGROUND)
})

// The seam between the Transcript's window and the Composer's border is the dock's own
// blank row: it stays put — and stays unpainted — however the Transcript ends.
it('the seam above the Composer is blank, never a slab', () => {
  const lines = styled(screen({ lines: [{ source: 'result', text: 'exit 0' }] }, VIEWPORT))

  expect(lines.at(-4)).toBe('')
  expect(lines.at(-3)).toContain('┌')
})

// A Plan write is the Plan itself: the call's block is one row per Step, each behind
// the mark its status earns, so the whole Plan reads at a glance.
it('a Plan write is one row per Step', () => {
  const state = screen({ lines: [{ source: 'call', text: '[ ] one\n[>] two' }] }, VIEWPORT)

  expect(bare(state).slice(0, 3)).toEqual(['', '[ ] one', '[>] two'])
})

// Only the agent writes markdown. What you typed is shown back exactly as typed, and a
// tool's output is already the text some other program chose.
it('the agent is read as markdown, and nobody else is', () => {
  const state = screen(
    {
      lines: [
        { source: 'agent', text: 'see `a.ts` and **b**' },
        { source: 'you', text: '> use *.ts and **glob**' },
        { source: 'result', text: '- not a list' },
      ],
    },
    VIEWPORT,
  )

  expect(bare(state).slice(0, 3)).toEqual([
    'see a.ts and b',
    '> use *.ts and **glob**',
    '- not a list',
  ])
  expect(colourful(<ScreenView screen={state} />, VIEWPORT.columns)).toContain(CYAN)
})

// A Turn that answered ends with the Composer coming back, and so does one that reached
// an Impasse, so the second has to say so in a way that reads as the loop and not the
// model.
const ENDED =
  'The Turn ended without an answer: the Gates refused 3 acts with none allowed in between, so the agent stopped trying. Ask again another way, or do this part yourself.'

const WIDE = { columns: 200, rows: 6 }

it('an Impasse stands out from the agent and its tools', () => {
  const state = screen(
    {
      lines: [
        { source: 'agent', text: 'let me try' },
        { source: 'loop', text: ENDED },
      ],
    },
    WIDE,
  )

  const lines = colourful(<ScreenView screen={state} />, WIDE.columns).split('\n')

  expect(lines[0]).toBe('let me try')
  expect(lines[1]).toContain(BOLD)
  expect(lines[1]).not.toContain(GREY_BACKGROUND)
  expect(plain(<ScreenView screen={state} />, WIDE.columns).split('\n')[1]).toBe(ENDED)
})

// A Turn the model broke ends the way one the Gates ended does: the loop's last word,
// said in bold, with the reason it carried named in the line.
const BROKE =
  'The Turn ended without an answer: the model broke down — OpenAI.streamText: Rate limit exceeded. Ask again, or do this part yourself.'

it('a Breakdown stands out the way an Impasse does', () => {
  const state = screen(
    {
      lines: [
        { source: 'agent', text: 'let me try' },
        { source: 'loop', text: BROKE },
      ],
    },
    WIDE,
  )

  const lines = colourful(<ScreenView screen={state} />, WIDE.columns).split('\n')

  expect(lines[0]).toBe('let me try')
  expect(lines[1]).toContain(BOLD)
  expect(lines[1]).not.toContain(GREY_BACKGROUND)
  expect(plain(<ScreenView screen={state} />, WIDE.columns).split('\n')[1]).toBe(BROKE)
})

// The loop says two things now, and they read differently: a Reminder is the loop
// mid-Turn, so it is set in italic, where an Impasse or a Breakdown is the loop's last
// word and stays bold. Neither wears a tool's grey.
const REMINDER = 'The agent was reminded of its Plan:\n[ ] read the code'

it('a Reminder is set in italic, not the bold of a Turn ending', () => {
  const state = screen({ lines: [{ source: 'reminder', text: REMINDER }] }, WIDE)

  const lines = colourful(<ScreenView screen={state} />, WIDE.columns).split('\n')

  expect(lines[0]).toContain(ITALIC)
  expect(lines[0]).not.toContain(BOLD)
  expect(lines[0]).not.toContain(GREY_BACKGROUND)
  expect(
    plain(<ScreenView screen={state} />, WIDE.columns)
      .split('\n')
      .slice(0, 2),
  ).toEqual(['The agent was reminded of its Plan:', '[ ] read the code'])
})
