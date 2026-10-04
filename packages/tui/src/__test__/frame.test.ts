import { expect, it } from '@effect/vitest'
import { AiError, Response } from 'effect/unstable/ai'

import { unpainted } from '#__test__/testing.ts'
import { face, send, start, transcribe, transcriptRows, view, written } from '#frame.ts'

import { CommandRefused } from 'agent'

import type { Breakdown, Impasse, ToolResult } from 'agent'
import type { Chord, Line, Screen, ScreenEvent } from '#frame.ts'

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

const reply = (id: string, text: string): ScreenEvent => ({
  activity: { id, text, type: 'reply' },
  type: 'activity',
})

/** The screen the key and Activity cases start from, sized like Ink's own fallback. */
const screen = (parts: Partial<Screen> = {}): Screen => ({
  ...start({ columns: 80, rows: 24 }),
  ...parts,
})

/**
 * A screen whose Transcript is taller than its window: ten one-row lines against a
 * three-row window, so the latest line sits at offset seven and a notch has room to move
 * in both directions.
 */
const tall = (offset: number, parts: Partial<Screen> = {}): Screen =>
  screen({
    lines: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].map(
      (text) => ({ source: 'you' as const, text: `> ${text}` }),
    ),
    offset,
    viewport: { columns: 80, rows: 7 },
    ...parts,
  })

const wheel = (notch: 'down' | 'sideways' | 'up'): ScreenEvent => ({ notch, type: 'wheel' })

it('a printable key lands at the end of the Draft', () => {
  const { screen: next } = send(screen({ draft: 'h' }), typed('i'))

  expect(next).toEqual(screen({ draft: 'hi' }))
})

// Three characters, so taking the last is told apart from keeping only the first.
it('backspace and delete each take the last character back', () => {
  expect(
    send(screen({ draft: 'hey' }), {
      chord: chord({ backspace: true }),
      input: '',
      type: 'key',
    }).screen,
  ).toEqual(screen({ draft: 'he' }))
  expect(
    send(screen({ draft: 'hey' }), { chord: chord({ delete: true }), input: '', type: 'key' })
      .screen,
  ).toEqual(screen({ draft: 'he' }))
})

it('backspace on an empty Draft leaves it empty', () => {
  expect(
    send(screen(), { chord: chord({ backspace: true }), input: '', type: 'key' }).screen,
  ).toEqual(screen())
})

it('a modifier chord types nothing', () => {
  expect(
    send(screen({ draft: 'hi' }), { chord: chord({ ctrl: true }), input: 'c', type: 'key' }).screen
      .draft,
  ).toBe('hi')
  expect(
    send(screen({ draft: 'hi' }), { chord: chord({ meta: true }), input: 'v', type: 'key' }).screen
      .draft,
  ).toBe('hi')
})

it('Return on a blank Draft submits nothing and keeps the blank', () => {
  expect(send(screen(), RETURN)).toEqual({ screen: screen() })
  expect(send(screen({ draft: '   ' }), RETURN).screen).toEqual(screen({ draft: '   ' }))
})

it('Return on a non-blank Draft echoes it as typed, clears the Draft, Locks, and yields the Request', () => {
  const step = send(screen({ draft: 'who am I' }), RETURN)

  expect(step.request).toBe('who am I')
  expect(step.screen).toEqual(
    screen({ lines: [{ source: 'you', text: '> who am I' }], locked: true }),
  )
})

// The echo keeps the Request's spaces and all: what is shown back is what was typed,
// not a trimmed version of it.
it('the Request is echoed exactly as typed', () => {
  const step = send(screen({ draft: '  say hi  ' }), RETURN)

  expect(step.request).toBe('  say hi  ')
  expect(step.screen.lines).toEqual([{ source: 'you', text: '>   say hi  ' }])
})

// A Turn in flight is not a place the draft can change: typing, backspace, and Return
// alike do nothing, so the first token cannot unlock a queue.
it('every key is ignored while the Composer is Locked', () => {
  const locked = screen({ draft: 'hi', locked: true })

  expect(send(locked, typed('x')).screen).toEqual(locked)
  expect(send(locked, RETURN)).toEqual({ screen: locked })
  expect(
    send(locked, { chord: chord({ backspace: true }), input: '', type: 'key' }).screen,
  ).toEqual(locked)
})

it('an Activity the screen shows lands on the Transcript', () => {
  const { screen: next } = send(screen(), {
    activity: { id: 'text-1', text: 'hi', type: 'reply' },
    type: 'activity',
  })

  expect(next).toEqual(screen({ lines: [{ id: 'text-1', source: 'agent', text: 'hi' }] }))
})

// A read that worked is quiet, so the Transcript does not grow for it.
it('an Activity the screen declines to show adds nothing', () => {
  expect(send(screen(), { activity: readFile, type: 'activity' }).screen).toEqual(screen())
})

// The Impasse is an Activity like any other: the Turn is not over until the ask settles,
// which is what unlocks the Composer, not the last line the Turn wrote.
it('an Activity that ends the Turn does not unlock the Composer on its own', () => {
  const { screen: next } = send(screen({ locked: true }), { activity: impasse, type: 'activity' })

  expect(next.locked).toBe(true)
  expect(next.lines).toEqual([{ source: 'loop', text: ENDED }])
})

it('the Turn ending unlocks the Composer', () => {
  expect(send(screen({ locked: true }), { type: 'ended' }).screen).toEqual(screen())
})

// A rejection is a defect in the session, not an Activity the Turn reported, so it is
// said in the loop's voice, the Composer comes back, and the line stays in view.
it("a rejection is said in the loop's voice, unlocks, and stays in view", () => {
  const { screen: next } = send(screen({ locked: true }), {
    message: 'the session broke',
    type: 'rejected',
  })

  expect(next).toEqual(
    screen({ lines: [{ source: 'loop', text: 'the session broke' }], locked: false }),
  )
  expect(view(next).rows.at(-1)).toEqual({ source: 'loop', text: 'the session broke' })
})

// The face is the Composer's one content row. The idle face matches the echo a
// submitted Request leaves: the chevron and the Draft, in ordinary text.
it('the idle face is the chevron and the Draft', () => {
  expect(face(screen({ draft: 'who am I' }))).toBe('> who am I')
})

// While Locked the face is a still ellipsis with no chevron.
it('the Locked face is the waiting ellipsis, not a chevron', () => {
  expect(face(screen({ draft: 'half typed', locked: true }))).toBe('…')
})

// The dock is claimed before the Transcript is given anything: the seam, the frame's
// top border, its one content row, and its bottom border. A window too short for the
// dock still claims it in full — the terminal clips the Transcript, never the place
// the next Request is typed.
it('the dock claims its rows first, and the Transcript gets the rest', () => {
  expect(transcriptRows({ columns: 80, rows: 24 })).toBe(20)
  expect(transcriptRows({ columns: 80, rows: 5 })).toBe(1)
  expect(transcriptRows({ columns: 80, rows: 4 })).toBe(0)
  expect(transcriptRows({ columns: 80, rows: 2 })).toBe(0)
})

it('a short Transcript starts at the top', () => {
  const shown = view(screen({ lines: [{ source: 'you', text: '> one' }] }))

  expect(shown.rows).toEqual([{ source: 'you', text: '> one' }])
})

// The view shows a window of the Transcript's laid-out rows: once there are more than
// the window holds, the top rows leave the screen and the tail stays. An Activity while
// Following pins the window to the new end, so the reply being written is on screen.
it('a long Transcript shows its tail, and an Activity keeps the end in view', () => {
  let state = screen({ viewport: { columns: 80, rows: 7 } })

  for (const text of ['one', 'two', 'three', 'four']) {
    state = send(state, reply(text, text)).screen
  }

  expect(view(state).rows).toEqual([
    { source: 'agent', text: 'two' },
    { source: 'agent', text: 'three' },
    { source: 'agent', text: 'four' },
  ])
})

it('the idle Composer is the chevron and the Draft, with the cursor after it', () => {
  const shown = view(screen({ draft: 'hi' }))

  expect(shown.composer).toBe('> hi')
  expect(shown.locked).toBe(false)
  expect(shown.cursor).toEqual({ row: 22, column: 5 })
})

it('the empty Draft leaves the cursor just after the chevron', () => {
  expect(view(screen()).cursor).toEqual({ row: 22, column: 3 })
})

// The Composer is one row: a Draft longer than the row slides so its end stays visible,
// and the cursor lands on the last content cell rather than off the frame.
it('a Draft longer than the row slides, with the cursor on the last cell', () => {
  const shown = view(screen({ draft: 'abcdefghijklmnop', viewport: { columns: 10, rows: 6 } }))

  expect(shown.composer).toBe('ijklmnop')
  expect(shown.cursor).toEqual({ row: 4, column: 8 })
})

// The slide is measured in the cells the terminal shows: an emoji is two of them, and
// counting characters would hide the end two cells early.
it('the slide is measured in cells, not characters', () => {
  const shown = view(screen({ draft: '🎉🎉', viewport: { columns: 6, rows: 6 } }))

  expect(shown.composer).toBe('🎉🎉')
  expect(shown.cursor).toEqual({ row: 4, column: 4 })
})

it('the Locked face is a still ellipsis and names no cursor cell', () => {
  const shown = view(screen({ draft: 'half typed', locked: true }))

  expect(shown.composer).toBe('…')
  expect(shown.locked).toBe(true)
  expect(shown.cursor).toBeUndefined()
})

// A submitted Request is the newest line of the Transcript, so the window jumps to the
// end however far the last one had scrolled: the echo and the reply are what is being
// waited on, and they are what is shown.
it('Return pins the echo and the tail of the Transcript in view', () => {
  let state = screen({ viewport: { columns: 80, rows: 7 }, draft: 'who am I' })

  for (const text of ['one', 'two', 'three', 'four']) {
    state = send(state, reply(text, text)).screen
  }

  const step = send(state, RETURN)

  expect(step.request).toBe('who am I')
  expect(step.screen.draft).toBe('')
  expect(step.screen.locked).toBe(true)
  expect(view(step.screen).rows).toEqual([
    { source: 'agent', text: 'three' },
    { source: 'agent', text: 'four' },
    { source: 'you', text: '> who am I' },
  ])
})

// A resize lays the Transcript out again — wrapping is what changes the row count —
// and the window ends pinned to the new end, so the latest line stays where a Following
// screen keeps it.
it('a resize lays the Transcript out to the new width and pins to the new end', () => {
  let state = screen({ viewport: { columns: 40, rows: 7 } })

  for (const text of ['a', '0123456789', 'b']) {
    state = send(state, reply(text, text)).screen
  }

  const resized = send(state, { type: 'resize', viewport: { columns: 7, rows: 7 } })

  expect(resized.screen.viewport).toEqual({ columns: 7, rows: 7 })
  expect(view(resized.screen).rows).toEqual([
    { source: 'agent', text: '0123456' },
    { source: 'agent', text: '789' },
    { source: 'agent', text: 'b' },
  ])
})

// Nothing but Return touches the offset: the wheel is #18's, and no key is a scroll.
it('no key moves the window', () => {
  let state = screen({ viewport: { columns: 80, rows: 7 } })

  for (const text of ['one', 'two', 'three', 'four']) {
    state = send(state, reply(text, text)).screen
  }

  expect(send(state, typed('')).screen.offset).toBe(state.offset)
  expect(send(state, typed('x')).screen.offset).toBe(state.offset)
})

// The wheel is the only scroll, and the keys that would be one on a screen with a cursor
// are not: an arrow, Page Up, Page Down, Home, and End reach the frame as a key with no
// character of its own — Ink hands each over that way — so neither the Draft nor the
// window changes under them.
it('a nav key changes neither the Draft nor the window', () => {
  const state = tall(4, { draft: 'hi' })

  expect(send(state, typed('')).screen).toEqual(state)
})

// A notch is three laid-out rows — far enough to move, close enough to keep your place —
// and it stops at both ends: the first line and the latest. Everything fits at the top,
// so there is nowhere for a notch to go.
it('a wheel notch moves three laid-out rows, and stops at both ends', () => {
  expect(send(tall(0), wheel('down')).screen.offset).toBe(3)
  expect(send(tall(7), wheel('up')).screen.offset).toBe(4)
  expect(send(tall(2), wheel('up')).screen.offset).toBe(0)
  expect(send(tall(6), wheel('down')).screen.offset).toBe(7)
  expect(send(tall(0), wheel('up')).screen.offset).toBe(0)
  expect(send(tall(7), wheel('down')).screen.offset).toBe(7)
})

// A Turn in flight is read the same way as an idle screen: a Locked Composer is not a
// Locked Transcript.
it('the wheel reads the Transcript while the Composer is Locked', () => {
  expect(send(tall(7, { locked: true }), wheel('up')).screen.offset).toBe(4)
  expect(send(tall(0, { locked: true }), wheel('down')).screen.offset).toBe(3)
})

it('a notch while everything fits and a sideways notch change nothing', () => {
  const fits = screen({ lines: [{ source: 'you', text: '> one' }] })

  expect(send(fits, wheel('up')).screen).toEqual(fits)
  expect(send(fits, wheel('down')).screen).toEqual(fits)
  expect(send(tall(4), wheel('sideways')).screen).toEqual(tall(4))
})

// Leaving the latest line Holds the reader where they are: the lines a Turn appends grow
// below the window instead of dragging it along, so what was being read stays put.
it('leaving the latest line Holds it: new lines stay off the screen', () => {
  const held = send(tall(7), wheel('up')).screen

  expect(held.offset).toBe(4)

  const shown = view(held).rows
  const next = send(held, reply('text-1', 'eleven')).screen

  expect(next.offset).toBe(4)
  expect(view(next).rows).toEqual(shown)
  expect(view(next).rows).toEqual([
    { source: 'you', text: '> five' },
    { source: 'you', text: '> six' },
    { source: 'you', text: '> seven' },
  ])
})

// Scrolling back onto the latest line is catching up, and a caught-up reader stays
// caught up: the next line appends into view.
it('scrolling onto the latest line resumes Following', () => {
  const held = send(tall(7), wheel('up')).screen
  const caught = send(held, wheel('down')).screen

  expect(caught.offset).toBe(7)

  const next = send(caught, reply('text-1', 'eleven')).screen

  expect(next.offset).toBe(8)
  expect(view(next).rows.at(-1)).toEqual({ source: 'agent', text: 'eleven' })
})

// Submitting is a jump to the end however far the reading had left it: the echo and the
// reply are what the Turn is being waited on for, so they are what is shown.
it('submitting pins the echo and the end in view even from Held', () => {
  const step = send(tall(4, { draft: 'who am I' }), RETURN)

  expect(step.request).toBe('who am I')
  expect(step.screen.offset).toBe(8)
  expect(view(step.screen).rows).toEqual([
    { source: 'you', text: '> nine' },
    { source: 'you', text: '> ten' },
    { source: 'you', text: '> who am I' },
  ])
})

// A resize lays the Transcript out again and clamps the offset. One that leaves the
// latest line revealed has caught the reader up, so the screen is Following.
it('a resize that reveals the latest line resumes Following', () => {
  const held = send(tall(7), wheel('up')).screen
  const roomy = send(held, { type: 'resize', viewport: { columns: 80, rows: 24 } }).screen

  expect(roomy.offset).toBe(0)

  const next = send(roomy, reply('text-1', 'eleven')).screen

  expect(view(next).rows.at(-1)).toEqual({ source: 'agent', text: 'eleven' })
})

// One that does not reveal the latest line leaves the reader Held, and the offset still
// points at real rows: the window is full, not showing past the end of the Transcript.
it('a resize that does not reveal the latest line leaves it Held, not past the end', () => {
  const held = send(tall(7), wheel('up')).screen

  const narrower = send(held, {
    type: 'resize',
    viewport: { columns: 40, rows: 7 },
  }).screen

  expect(narrower.offset).toBe(4)
  expect(view(narrower).rows).toEqual(view(held).rows)
})

// The blank row above a call is a margin today, so it is a row of the frame like any
// other — one that is painted by nobody, which is what keeps it out of the slab.
it('a call is set off by a blank row of its own', () => {
  const shown = view(
    screen({
      lines: [
        { source: 'call', text: '$ echo hi' },
        { source: 'result', text: 'exit 0\nhi' },
      ],
    }),
  )

  expect(shown.rows).toEqual([
    { source: 'gap', text: '' },
    { source: 'call', text: '$ echo hi' },
    { source: 'result', text: 'exit 0' },
    { source: 'result', text: 'hi' },
  ])
})

it('a chain of calls is broken up, while a result stays under its call', () => {
  const shown = view(
    screen({
      lines: [
        { source: 'call', text: '$ echo hi' },
        { source: 'result', text: 'exit 0' },
        { source: 'call', text: 'read a.ts' },
      ],
    }),
  )

  expect(shown.rows.map((row) => row.source)).toEqual(['gap', 'call', 'result', 'gap', 'call'])
})

it('the agent is laid out as markdown, a blank row between its blocks', () => {
  const shown = unpainted(() =>
    view(screen({ lines: [{ source: 'agent', text: 'One.\n\nTwo.' }] })),
  )

  expect(shown.rows).toEqual([
    { source: 'agent', text: 'One.' },
    { source: 'gap', text: '' },
    { source: 'agent', text: 'Two.' },
  ])
})

it('an agent line with nothing in it takes up no room', () => {
  const shown = unpainted(() =>
    view(
      screen({
        lines: [
          { source: 'agent', text: '' },
          { source: 'you', text: '> hi' },
        ],
      }),
    ),
  )

  expect(shown.rows).toEqual([{ source: 'you', text: '> hi' }])
})

it('a list item that wraps continues under its own words', () => {
  const shown = unpainted(() =>
    view(
      screen({
        lines: [{ source: 'agent', text: '- alpha beta gamma delta' }],
        viewport: { columns: 14, rows: 24 },
      }),
    ),
  )

  expect(shown.rows).toEqual([
    { source: 'agent', text: '• alpha beta' },
    { source: 'agent', text: '  gamma delta' },
  ])
})

// A nested list is not drawn inside its parent but follows it, indented by the depth it
// was found at, and its continuations hang under its own marker like any other item's.
it('a nested list starts indented under the item above it', () => {
  const shown = unpainted(() =>
    view(screen({ lines: [{ source: 'agent', text: '- one\n  - deeper' }] })),
  )

  expect(shown.rows).toEqual([
    { source: 'agent', text: '• one' },
    { source: 'agent', text: '  • deeper' },
  ])
})

// A wrapped row is the row Ink's own wrap would have made, whitespace and all: at
// `trim: false` a space that fell on a line break stays in front of the next row, and
// the frame keeps it — it trims only the tail, which is all Ink's painting trims.
it('a wrapped row keeps the space a line break left in front of it', () => {
  const shown = unpainted(() =>
    view(
      screen({
        lines: [{ source: 'agent', text: '- alpha beta gamma delta' }],
        viewport: { columns: 12, rows: 24 },
      }),
    ),
  )

  expect(shown.rows).toEqual([
    { source: 'agent', text: '• alpha beta' },
    { source: 'agent', text: '   gamma' },
    { source: 'agent', text: '  delta' },
  ])
})

it('a quotation is barred down its left and wraps clear of the bar', () => {
  const shown = unpainted(() =>
    view(
      screen({
        lines: [{ source: 'agent', text: '> one two three four\n> last' }],
        viewport: { columns: 12, rows: 24 },
      }),
    ),
  )

  expect(shown.rows).toEqual([
    { source: 'agent', text: '│ one two' },
    { source: 'agent', text: '  three four' },
    { source: 'agent', text: '│ last' },
  ])
})
