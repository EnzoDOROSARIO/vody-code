import { expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { AiError, Response } from 'effect/unstable/ai'

import { App, Prompt, Transcript, keystroke, transcribe, written } from '#app.tsx'
import { BOLD, DIM, GREY_BACKGROUND, colourful, plain } from './testing.ts'

import { CommandRefused } from 'agent'

import type { Breakdown, Impasse, ToolResult } from 'agent'
import type { Line } from '#app.tsx'
import type { Chord } from '#app.tsx'

const chord = (pressed: Partial<Chord>): Chord => ({
  backspace: false,
  ctrl: false,
  delete: false,
  meta: false,
  return: false,
  ...pressed,
})

const RETURN = chord({ return: true })

const never: () => Promise<void> = () => Effect.runPromise(Effect.never)

const transcript: ReadonlyArray<Line> = [
  { source: 'you', text: '> say hi' },
  { source: 'call', text: '$ echo hi' },
  { source: 'agent', text: 'hi' },
]

const ranBash: ToolResult = Response.toolResultPart({
  encodedResult: 'exit 0\nhi',
  id: 'call-1',
  isFailure: false,
  name: 'bash',
  preliminary: false,
  providerExecuted: false,
  result: 'exit 0\nhi',
})

const readFile: ToolResult = Response.toolResultPart({
  encodedResult: 'the whole file',
  id: 'call-2',
  isFailure: false,
  name: 'read_file',
  preliminary: false,
  providerExecuted: false,
  result: 'the whole file',
})

it('each tool call is announced in the wording that suits it', () => {
  expect(
    transcribe({ id: 'c', name: 'bash', params: { command: 'echo hi' }, type: 'tool-call' }),
  ).toEqual({ source: 'call', text: '$ echo hi' })
  expect(
    transcribe({ id: 'c', name: 'read_file', params: { path: 'a.ts' }, type: 'tool-call' }),
  ).toEqual({ source: 'call', text: 'read a.ts' })
  expect(
    transcribe({
      id: 'c',
      name: 'write_file',
      params: { content: 'x', path: 'a.ts' },
      type: 'tool-call',
    }),
  ).toEqual({ source: 'call', text: 'write a.ts' })
  expect(
    transcribe({
      id: 'c',
      name: 'edit_file',
      params: { new_text: 'b', old_text: 'a', path: 'a.ts' },
      type: 'tool-call',
    }),
  ).toEqual({ source: 'call', text: 'edit a.ts' })
  expect(
    transcribe({ id: 'c', name: 'glob', params: { pattern: '*.ts' }, type: 'tool-call' }),
  ).toEqual({ source: 'call', text: 'glob *.ts' })
})

it('bash quotes its output back, exit status first, and the others stay quiet', () => {
  expect(transcribe(ranBash)).toEqual({ source: 'result', text: 'exit 0\nhi' })
  expect(transcribe(readFile)).toBeUndefined()
})

// The quote is cut to the preview, keeping the front: output that ran long still shows
// the exit status the first line is there for.
it('bash output longer than the preview is cut, keeping the front', () => {
  const long: ToolResult = Response.toolResultPart({
    encodedResult: `x${'y'.repeat(300)}tail`,
    id: 'call-6',
    isFailure: false,
    name: 'bash',
    preliminary: false,
    providerExecuted: false,
    result: `x${'y'.repeat(300)}tail`,
  })

  expect(transcribe(long)?.text).toHaveLength(200)
  expect(transcribe(long)?.text.startsWith('x')).toBe(true)
  expect(transcribe(long)?.text.endsWith('tail')).toBe(false)
})

it('a tool that failed says which tool, and why', () => {
  const refused: ToolResult = Response.toolResultPart({
    encodedResult: {},
    id: 'call-3',
    isFailure: true,
    name: 'bash',
    preliminary: false,
    providerExecuted: false,
    result: new CommandRefused({ reason: 'rm -rf is not allowed here' }),
  })

  expect(transcribe(refused)).toEqual({
    source: 'result',
    text: 'bash failed: rm -rf is not allowed here',
  })
})

// The model's own errors are failures a tool result can carry too, and they state
// themselves in `message` rather than `reason`. Quoting `reason` here would leave the
// line holding the word for nothing.
it('a failure of the model the tool ran under says what the framework said', () => {
  const modelFailure: ToolResult = Response.toolResultPart({
    encodedResult: {},
    id: 'call-5',
    isFailure: true,
    name: 'bash',
    preliminary: false,
    providerExecuted: false,
    result: AiError.make({
      method: 'streamText',
      module: 'OpenAI',
      reason: new AiError.RateLimitError({}),
    }),
  })

  expect(transcribe(modelFailure)).toEqual({
    source: 'result',
    text: 'bash failed: OpenAI.streamText: Rate limit exceeded',
  })
})

it('a call the agent never ran says so in the same breath', () => {
  const denied: ToolResult = Response.toolResultPart({
    encodedResult: {},
    id: 'call-4',
    isFailure: true,
    name: 'write_file',
    preliminary: false,
    providerExecuted: false,
    result: { reason: 'the user said no', type: 'execution-denied' },
  })

  expect(transcribe(denied)).toEqual({
    source: 'result',
    text: 'write_file failed: the user said no',
  })
})

const impasse: Impasse = { refusals: 3, type: 'impasse' }

const ENDED =
  'The Turn ended without an answer: the Gates refused 3 acts with none allowed in between, so the agent stopped trying. Ask again another way, or do this part yourself.'

// A Turn that answered ends with the prompt coming back, and so does one that reached an
// Impasse, so the second has to say so, or the person waits for an answer that is not
// coming.
it('a Turn that reached an Impasse says so, and says it is over', () => {
  expect(transcribe(impasse)).toEqual({ source: 'loop', text: ENDED })
})

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

const breakdown: Breakdown = {
  reason: 'OpenAI.streamText: Rate limit exceeded',
  type: 'breakdown',
}

const BROKE =
  'The Turn ended without an answer: the model broke down — OpenAI.streamText: Rate limit exceeded. Ask again, or do this part yourself.'

// A Turn the model broke ends the way one the Gates ended does: the loop's last word,
// said in bold, with the reason it carried named in the line.
it('a Turn the model broke says so, and says why', () => {
  expect(transcribe(breakdown)).toEqual({ source: 'loop', text: BROKE })
})

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

it('the reply is the agent speaking, not a tool', () => {
  expect(transcribe({ id: 'text-1', text: 'done', type: 'reply' })).toEqual({
    id: 'text-1',
    source: 'agent',
    text: 'done',
  })
})

// The agent hands over its answer in the fragments it wrote, and the transcript is
// where they are put back together: this is the whole of what makes a reply appear on
// the screen as it is being written, rather than all at once when the turn is over.
it('a fragment of the block being written lengthens that line', () => {
  const opened = written([], { id: 'text-1', source: 'agent', text: 'it printed ' })

  expect(written(opened, { id: 'text-1', source: 'agent', text: 'hi' })).toEqual([
    { id: 'text-1', source: 'agent', text: 'it printed hi' },
  ])
})

it('the next block of a reply starts a line of its own', () => {
  const said: ReadonlyArray<Line> = [{ id: 'text-1', source: 'agent', text: 'one' }]

  expect(written(said, { id: 'text-2', source: 'agent', text: 'two' })).toEqual([
    { id: 'text-1', source: 'agent', text: 'one' },
    { id: 'text-2', source: 'agent', text: 'two' },
  ])
})

it('a line that arrives whole never joins the one above it', () => {
  const said: ReadonlyArray<Line> = [{ source: 'agent', text: 'the turn broke' }]

  expect(written(said, { source: 'agent', text: 'and again' })).toEqual([
    { source: 'agent', text: 'the turn broke' },
    { source: 'agent', text: 'and again' },
  ])
  expect(written([], { source: 'call', text: '$ echo hi' })).toEqual([
    { source: 'call', text: '$ echo hi' },
  ])
})

it('a fragment after a tool ran starts the line the answer is written on', () => {
  const said: ReadonlyArray<Line> = [
    { id: 'text-1', source: 'agent', text: 'let me look' },
    { source: 'result', text: 'exit 0' },
  ]

  expect(written(said, { id: 'text-1', source: 'agent', text: 'it printed hi' })).toEqual([
    ...said,
    { id: 'text-1', source: 'agent', text: 'it printed hi' },
  ])
})

it('the transcript renders each line above the prompt', () => {
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
// glob or a star in a question survives, and a tool's output is text some other program
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

it('the prompt shows what has been typed so far', () => {
  expect(plain(<Prompt busy={false} value="who am I" />)).toBe('> who am I')
})

it('the prompt waits while the agent is working', () => {
  expect(plain(<Prompt busy value="" />)).toBe('…')
})

it('the app starts with an empty transcript and an empty prompt', () => {
  expect(plain(<App ask={never} />)).toBe('>')
})

it('a printable key lands at the end of what is typed', () => {
  expect(keystroke(false, chord({}), 'i', 'h')).toEqual({ submit: false, value: 'hi' })
})

it('backspace and delete each take the last character back', () => {
  expect(keystroke(false, chord({ backspace: true }), '', 'hi')).toEqual({
    submit: false,
    value: 'h',
  })
  expect(keystroke(false, chord({ delete: true }), '', 'hi')).toEqual({
    submit: false,
    value: 'h',
  })
  // Three characters, so taking the last is told apart from keeping only the first.
  expect(keystroke(false, chord({ backspace: true }), '', 'hey')).toEqual({
    submit: false,
    value: 'he',
  })
  expect(keystroke(false, chord({ delete: true }), '', 'hey')).toEqual({
    submit: false,
    value: 'he',
  })
})

it('backspace on an empty prompt leaves it empty', () => {
  expect(keystroke(false, chord({ backspace: true }), '', '')).toEqual({ submit: false, value: '' })
})

it('return submits what is typed and clears the prompt', () => {
  expect(keystroke(false, RETURN, '', 'who am I')).toEqual({ submit: true, value: '' })
})

it('return on blank input submits nothing and keeps the blank', () => {
  expect(keystroke(false, RETURN, '', '   ')).toEqual({ submit: false, value: '   ' })
  expect(keystroke(false, RETURN, '', '')).toEqual({ submit: false, value: '' })
})

it('a modifier chord types nothing', () => {
  expect(keystroke(false, chord({ ctrl: true }), 'c', 'hi')).toEqual({ submit: false, value: 'hi' })
  expect(keystroke(false, chord({ meta: true }), 'v', 'hi')).toEqual({ submit: false, value: 'hi' })
})

it('every key is ignored while the agent is working', () => {
  expect(keystroke(true, chord({}), 'x', 'hi')).toEqual({ submit: false, value: 'hi' })
  expect(keystroke(true, RETURN, '', 'hi')).toEqual({ submit: false, value: 'hi' })
  expect(keystroke(true, chord({ backspace: true }), '', 'hi')).toEqual({
    submit: false,
    value: 'hi',
  })
})
