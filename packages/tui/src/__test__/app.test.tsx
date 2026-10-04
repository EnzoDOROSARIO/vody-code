import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'

import { App, Composer, Transcript } from '#app.tsx'
import { face } from '#frame.ts'
import { BOLD, DIM, GREY_BACKGROUND, colourful, plain } from './testing.ts'

import type { Line } from '#frame.ts'

const never: () => Promise<void> = () => Effect.runPromise(Effect.never)

const transcript: ReadonlyArray<Line> = [
  { source: 'you', text: '> say hi' },
  { source: 'call', text: '$ echo hi' },
  { source: 'agent', text: 'hi' },
]

const ENDED =
  'The Turn ended without an answer: the Gates refused 3 acts with none allowed in between, so the agent stopped trying. Ask again another way, or do this part yourself.'

const BROKE =
  'The Turn ended without an answer: the model broke down — OpenAI.streamText: Rate limit exceeded. Ask again, or do this part yourself.'

// A Turn that answered ends with the prompt coming back, and so does one that reached an
// Impasse, so the second has to say so in a way that reads as the loop and not the model.
it('an Impasse stands out from the agent and its tools', () => {
  const lines: ReadonlyArray<Line> = [
    { source: 'agent', text: 'let me try' },
    { source: 'loop', text: ENDED },
  ]

  const [agent, ended] = colourful(<Transcript lines={lines} />, 400).split('\n')

  expect(agent).toBe('let me try')
  expect(ended).toContain(BOLD)
  expect(ended).not.toContain(GREY_BACKGROUND)
  expect(plain(<Transcript lines={lines} />, 400)).toBe(`let me try\n${ENDED}`)
})

// A Turn the model broke ends the way one the Gates ended does: the loop's last word,
// said in bold, with the reason it carried named in the line.
it('a Breakdown stands out the way an Impasse does', () => {
  const lines: ReadonlyArray<Line> = [
    { source: 'agent', text: 'let me try' },
    { source: 'loop', text: BROKE },
  ]

  const [agent, ended] = colourful(<Transcript lines={lines} />, 400).split('\n')

  expect(agent).toBe('let me try')
  expect(ended).toContain(BOLD)
  expect(ended).not.toContain(GREY_BACKGROUND)
  expect(plain(<Transcript lines={lines} />, 400)).toBe(`let me try\n${BROKE}`)
})

it('the transcript renders each line under the one before it', () => {
  expect(plain(<Transcript lines={transcript} />)).toBe('> say hi\n\n$ echo hi\nhi')
})

it('a tool line carries a grey background and dim text, and the rest carry neither', () => {
  const [you, , call, agent] = colourful(<Transcript lines={transcript} />).split('\n')

  expect(call).toContain(GREY_BACKGROUND)
  expect(call).toContain(DIM)
  expect(you).toBe('> say hi')
  expect(agent).toBe('hi')
})

// Only the agent writes markdown. What you typed is shown back exactly as typed, so a
// glob or a star in a request survives, and a tool's output is text some other program
// chose and is no one's to reformat.
it('the agent is read as markdown, and nobody else is', () => {
  expect(plain(<Transcript lines={[{ source: 'agent', text: 'see `a.ts` and **b**' }]} />)).toBe(
    'see a.ts and b',
  )
  expect(plain(<Transcript lines={[{ source: 'you', text: '> use *.ts and **glob**' }]} />)).toBe(
    '> use *.ts and **glob**',
  )
  expect(plain(<Transcript lines={[{ source: 'result', text: '- not a list' }]} />)).toBe(
    '- not a list',
  )
})

it('an agent line with nothing in it takes up no room', () => {
  expect(
    plain(
      <Transcript
        lines={[
          { source: 'agent', text: '' },
          { source: 'you', text: '> hi' },
        ]}
      />,
    ),
  ).toBe('> hi')
})

it('a chain of calls is broken up, while a call keeps the output under it', () => {
  const chained: ReadonlyArray<Line> = [
    { source: 'call', text: '$ echo hi' },
    { source: 'result', text: 'exit 0' },
    { source: 'result', text: 'hi' },
    { source: 'call', text: 'read a.ts' },
  ]

  expect(plain(<Transcript lines={chained} />)).toBe('\n$ echo hi\nexit 0\nhi\n\nread a.ts')
})

it('the gap above a call is bare, not another row of grey', () => {
  const [, gap] = colourful(<Transcript lines={transcript} />).split('\n')

  expect(gap).toBe('')
})

it('the idle face is painted as the chevron and the Draft', () => {
  expect(plain(<Composer text={face({ draft: 'who am I', lines: [], locked: false })} />)).toBe(
    '> who am I',
  )
})

it('the waiting face is painted as a still ellipsis, with no chevron', () => {
  expect(plain(<Composer text={face({ draft: 'half typed', lines: [], locked: true })} />)).toBe(
    '…',
  )
})

it('the app starts with an empty transcript and an empty composer', () => {
  expect(plain(<App ask={never} />)).toBe('>')
})
