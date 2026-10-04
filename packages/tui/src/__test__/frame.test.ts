import { expect, it } from '@effect/vitest'
import { AiError, Response } from 'effect/unstable/ai'

import { face, send, start, transcribe, written } from '#frame.ts'

import { CommandRefused } from 'agent'

import type { Breakdown, Impasse, ToolResult } from 'agent'
import type { Chord, Line, ScreenEvent } from '#frame.ts'

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

// What Ink hands `useInput` for a key: the character typed, and the chords held down.
// Every chord is spelled out so a test that presses none of them says so.
const chord = (pressed: Partial<Chord>): Chord => ({
  backspace: false,
  ctrl: false,
  delete: false,
  meta: false,
  return: false,
  ...pressed,
})

const typed = (input: string): ScreenEvent => ({ chord: chord({}), input, type: 'key' })

const RETURN: ScreenEvent = { chord: chord({ return: true }), input: '', type: 'key' }

it('a printable key lands at the end of the Draft', () => {
  const { screen } = send({ ...start, draft: 'h' }, typed('i'))

  expect(screen).toEqual({ draft: 'hi', lines: [], locked: false })
})

// Three characters, so taking the last is told apart from keeping only the first.
it('backspace and delete each take the last character back', () => {
  expect(
    send({ ...start, draft: 'hey' }, { chord: chord({ backspace: true }), input: '', type: 'key' })
      .screen,
  ).toEqual({ draft: 'he', lines: [], locked: false })
  expect(
    send({ ...start, draft: 'hey' }, { chord: chord({ delete: true }), input: '', type: 'key' })
      .screen,
  ).toEqual({ draft: 'he', lines: [], locked: false })
})

it('backspace on an empty Draft leaves it empty', () => {
  expect(send(start, { chord: chord({ backspace: true }), input: '', type: 'key' }).screen).toEqual(
    start,
  )
})

it('a modifier chord types nothing', () => {
  expect(
    send({ ...start, draft: 'hi' }, { chord: chord({ ctrl: true }), input: 'c', type: 'key' })
      .screen.draft,
  ).toBe('hi')
  expect(
    send({ ...start, draft: 'hi' }, { chord: chord({ meta: true }), input: 'v', type: 'key' })
      .screen.draft,
  ).toBe('hi')
})

it('Return on a blank Draft submits nothing and keeps the blank', () => {
  expect(send(start, RETURN)).toEqual({ screen: start })
  expect(send({ ...start, draft: '   ' }, RETURN).screen).toEqual({ ...start, draft: '   ' })
})

it('Return on a non-blank Draft echoes it as typed, clears the Draft, Locks, and yields the Request', () => {
  const step = send({ ...start, draft: 'who am I' }, RETURN)

  expect(step.request).toBe('who am I')
  expect(step.screen).toEqual({
    draft: '',
    lines: [{ source: 'you', text: '> who am I' }],
    locked: true,
  })
})

// The echo keeps the Request's spaces and all: what is shown back is what was typed,
// not a trimmed version of it.
it('the Request is echoed exactly as typed', () => {
  const step = send({ ...start, draft: '  say hi  ' }, RETURN)

  expect(step.request).toBe('  say hi  ')
  expect(step.screen.lines).toEqual([{ source: 'you', text: '>   say hi  ' }])
})

// A Turn in flight is not a place the draft can change: typing, backspace, and Return
// alike do nothing, so the first token cannot unlock a queue.
it('every key is ignored while the Composer is Locked', () => {
  const locked = { ...start, draft: 'hi', locked: true }

  expect(send(locked, typed('x')).screen).toEqual(locked)
  expect(send(locked, RETURN)).toEqual({ screen: locked })
  expect(
    send(locked, { chord: chord({ backspace: true }), input: '', type: 'key' }).screen,
  ).toEqual(locked)
})

it('an Activity the screen shows lands on the Transcript', () => {
  const { screen } = send(start, {
    activity: { id: 'text-1', text: 'hi', type: 'reply' },
    type: 'activity',
  })

  expect(screen).toEqual({
    draft: '',
    lines: [{ id: 'text-1', source: 'agent', text: 'hi' }],
    locked: false,
  })
})

// A read that worked is quiet, so the Transcript does not grow for it.
it('an Activity the screen declines to show adds nothing', () => {
  expect(send(start, { activity: readFile, type: 'activity' }).screen).toEqual(start)
})

// The Impasse is an Activity like any other: the Turn is not over until the ask settles,
// which is what unlocks the Composer, not the last line the Turn wrote.
it('an Activity that ends the Turn does not unlock the Composer on its own', () => {
  const { screen } = send({ ...start, locked: true }, { activity: impasse, type: 'activity' })

  expect(screen.locked).toBe(true)
  expect(screen.lines).toEqual([{ source: 'loop', text: ENDED }])
})

it('the Turn ending unlocks the Composer', () => {
  expect(send({ ...start, locked: true }, { type: 'ended' }).screen).toEqual(start)
})

// A rejection is a defect in the session, not an Activity the Turn reported, so it is
// said in the loop's voice and the Composer comes back either way.
it("a rejection is said in the loop's voice and unlocks the Composer", () => {
  const { screen } = send(
    { ...start, locked: true },
    {
      message: 'the session broke',
      type: 'rejected',
    },
  )

  expect(screen).toEqual({
    draft: '',
    lines: [{ source: 'loop', text: 'the session broke' }],
    locked: false,
  })
})

// The face is the Composer's one content row. The idle face matches the echo a
// submitted Request leaves: the chevron and the Draft, in ordinary text.
it('the idle face is the chevron and the Draft', () => {
  expect(face({ draft: 'who am I', lines: [], locked: false })).toBe('> who am I')
})

// While Locked the face is a still ellipsis with no chevron.
it('the Locked face is the waiting ellipsis, not a chevron', () => {
  expect(face({ draft: 'half typed', lines: [], locked: true })).toBe('…')
})
