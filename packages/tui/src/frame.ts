import { Predicate } from 'effect'
import stringWidth from 'string-width'

import { casesHandled } from './defects.ts'
import { layout, wrapped } from './markdown/layout.ts'

import type { Activity, Breakdown, Impasse, ToolCall, ToolFailure, ToolResult } from 'agent'

/**
 * Who put a line in the transcript, which is all its styling depends on. `loop` is the
 * agent too, but the turn loop speaking rather than the model: the Turn is over, and not
 * because the model had finished — an Impasse, or a Breakdown.
 */
export type Source = 'agent' | 'call' | 'loop' | 'result' | 'you'

/**
 * One line of the transcript.
 *
 * A line the agent is still writing carries the id of the block of prose it holds, so
 * the next fragment of that block knows to land on the end of it. Everything else — a
 * request, a tool, a turn that broke — arrives whole and has no id to carry.
 */
export type Line = {
  readonly id?: string
  readonly source: Source
  readonly text: string
}

const PREVIEW_CHARACTERS = 200

// The agent reports that it called `bash` with a command; saying that back as a
// shell prompt is this screen's business, and every tool gets the phrasing that
// suits it. Adding a tool to the agent lands here as a missing branch.
const asked = (call: ToolCall): string => {
  switch (call.name) {
    case 'bash':
      return `$ ${call.params.command}`
    case 'edit_file':
      return `edit ${call.params.path}`
    case 'glob':
      return `glob ${call.params.pattern}`
    case 'read_file':
      return `read ${call.params.path}`
    case 'write_file':
      return `write ${call.params.path}`
    // Stryker disable next-line ConditionalExpression: every ToolCall has an arm above, so this one is reached only by a value the type rules out, and no test can build one without an assertion
    default:
      return casesHandled(call)
  }
}

// Every tool states a failure in one string field, and so does a call the agent
// declined to run. Only the model's own errors put something else there, and they
// carry the sentence in `message` instead.
const because = (failure: ToolFailure): string =>
  Predicate.isTagged(failure, 'AiError') ? failure.message : failure.reason

// A tool that worked has usually said what it did in the line announcing it, so only
// `bash` is worth quoting back. A tool that failed has not been heard from at all.
//
// What `bash` returns opens with its exit status, so that status is what the first
// line of the quote shows. The `Console.log` this replaced previewed the raw output
// and left the status out; showing it costs a few characters of the preview and is
// worth them. Anything narrower would mean reading a shape the agent composed for the
// model, which is the coupling this screen exists to avoid.
const gave = (result: ToolResult): string | undefined => {
  if (result.isFailure) {
    return `${result.name} failed: ${because(result.result)}`
  }

  return result.name === 'bash' ? result.result.slice(0, PREVIEW_CHARACTERS) : undefined
}

// Both of the loop's endings are said in one voice — the Turn is over, with no answer —
// and they differ in why it ended, and in how asking again could help: an Impasse wants
// the request asked another way, where a model that broke may just answer the same one.
const ended = (why: string, again: string): string =>
  `The Turn ended without an answer: ${why}. ${again}, or do this part yourself.`

// A Turn that reached an Impasse hands the prompt back just as one that answered does, so
// the line has to say it is over and why, or the person sits waiting for an answer that is
// not coming. The refusals themselves are the lines above it, each with its reasons.
const stopped = (impasse: Impasse): string =>
  ended(
    `the Gates refused ${impasse.refusals} acts with none allowed in between, so the agent stopped trying`,
    'Ask again another way',
  )

// A Turn the model broke ends the same way, and the line says why in the words the
// failure gave it: nothing the model wrote after the break is coming either.
const broke = (breakdown: Breakdown): string =>
  ended(`the model broke down — ${breakdown.reason}`, 'Ask again')

export const transcribe = (activity: Activity): Line | undefined => {
  switch (activity.type) {
    case 'reply':
      return { id: activity.id, source: 'agent', text: activity.text }
    case 'tool-call':
      return { source: 'call', text: asked(activity) }
    case 'tool-result': {
      const shown = gave(activity)

      return shown === undefined ? undefined : { source: 'result', text: shown }
    }

    case 'impasse':
      return { source: 'loop', text: stopped(activity) }
    case 'breakdown':
      return { source: 'loop', text: broke(activity) }
    // Stryker disable next-line ConditionalExpression: every Activity has an arm above, so this one is reached only by a value the type rules out, and no test can build one without an assertion
    default:
      return casesHandled(activity)
  }
}

// The agent's answer arrives a fragment at a time, so the transcript grows two ways: a
// fragment of the block the last line is already holding lengthens that line, and
// everything else lands under it. The first is what a reply being typed out is made of.
//
// Matching on the id rather than on the source is what keeps the second block of a
// reply, and a turn that broke, from being swallowed by the line above them.
export const written = (lines: ReadonlyArray<Line>, entry: Line): ReadonlyArray<Line> => {
  const last = lines.at(-1)

  if (entry.id === undefined || last?.id !== entry.id) {
    return [...lines, entry]
  }

  return [...lines.slice(0, -1), { ...last, text: last.text + entry.text }]
}

/**
 * The chord flags a keystroke carries, the same five Ink reads off a key. Naming them
 * here keeps the frame independent of Ink's `Key` type: the shell hands over any object
 * carrying these, and the frame never learns what a terminal is.
 */
export type Chord = {
  readonly backspace: boolean
  readonly ctrl: boolean
  readonly delete: boolean
  readonly meta: boolean
  readonly return: boolean
}

/** Which way a wheel notch rolls. A sideways notch is no scroll at all. */
export type Notch = 'down' | 'sideways' | 'up'

/**
 * The window the frame is drawn to, in the terminal's own cells. The rows are what the
 * dock and the Transcript's window divide between them; the columns are what every line
 * is laid out to.
 */
export type Viewport = {
  readonly columns: number
  readonly rows: number
}

/**
 * Everything the screen knows: the lines of the Transcript, the Draft in the Composer,
 * whether the Composer is Locked for a Turn in flight, where the Transcript's window
 * sits among its laid-out rows, and the window it is drawn to.
 *
 * Following is not a flag beside the offset: it is the offset equalling the latest
 * laid-out row, which is zero while everything fits. Held is the offset above that end,
 * so the latest line is off the screen. A wheel notch is what moves it there; everything
 * that appends decides whether to keep the offset or carry it to the new end.
 */
export type Screen = {
  readonly draft: string
  readonly lines: ReadonlyArray<Line>
  readonly locked: boolean
  readonly offset: number
  readonly viewport: Viewport
}

/**
 * One thing that happens to the screen: a key, a wheel notch, an Activity the Turn
 * reported, the Turn ending, the ask itself being rejected, or the terminal being
 * resized.
 */
export type ScreenEvent =
  | { readonly chord: Chord; readonly input: string; readonly type: 'key' }
  | { readonly activity: Activity; readonly type: 'activity' }
  | { readonly type: 'ended' }
  | { readonly message: string; readonly type: 'rejected' }
  | { readonly type: 'resize'; readonly viewport: Viewport }
  | { readonly notch: Notch; readonly type: 'wheel' }

/** What one event does: the next screen, and the Request when a submit happened. */
export type Step = {
  readonly request?: string
  readonly screen: Screen
}

/** The screen before anyone has typed or the agent has said anything. */
export const start = (viewport: Viewport): Screen => ({
  draft: '',
  lines: [],
  locked: false,
  offset: 0,
  viewport,
})

/**
 * The Composer's content row. The idle face is the chevron and the Draft, which is the
 * same shape the Transcript keeps for a submitted Request. The Locked face is a still
 * ellipsis with no chevron.
 */
export const face = (screen: Screen): string => (screen.locked ? '…' : `> ${screen.draft}`)

/**
 * One terminal row of the Transcript's window: the text to paint, and what paints it.
 *
 * A `gap` is a row belonging to no line — the margin above a call, the blank between the
 * agent's blocks — so the shell paints nothing there, which is what keeps a tool's grey
 * slab from covering the seam it is read by.
 */
export type Row = {
  readonly source: Source | 'gap'
  readonly text: string
}

// The rows the dock claims before the Transcript is given any: the seam, the frame's
// top border, its one content row, and its bottom border. A window shorter than this
// still claims all four, and the terminal clips what will not fit.
const DOCK = 4

/** How many rows the Transcript's window has: whatever the dock leaves, possibly none. */
export const transcriptRows = (viewport: Viewport): number => Math.max(0, viewport.rows - DOCK)

// The agent is the one line that is markdown, and the layout module draws its blocks: a
// blank row between them, a list's continuation under its own words, a quotation barred
// down its left with the words wrapping clear of the bar. This only names what paints
// each row; the rows already carry their styling.
const markdown = (text: string, columns: number): ReadonlyArray<Row> =>
  layout(text, columns).map((row) =>
    row.type === 'gap' ? { source: 'gap', text: '' } : { source: 'agent', text: row.text },
  )

// One Transcript line to the rows of the window it takes. Only the agent is more than
// the text it holds; a call claims a blank row above it, which is the seam that keeps
// one chain of tools from reading as a single slab.
const rowsOf = (line: Line, columns: number): ReadonlyArray<Row> => {
  if (line.source === 'agent') {
    return markdown(line.text, columns)
  }

  if (line.source === 'call') {
    const rows: Array<Row> = [{ source: 'gap', text: '' }]

    for (const text of wrapped(line.text, columns)) {
      rows.push({ source: 'call', text })
    }

    return rows
  }

  return wrapped(line.text, columns).map((text) => ({ source: line.source, text }))
}

// The whole Transcript laid out to rows, in order. Scroll counts these rows and not the
// source lines, because a wrapped line takes more than one and the person scrolls what
// they see.
const laidOut = (lines: ReadonlyArray<Line>, columns: number): ReadonlyArray<Row> =>
  lines.flatMap((line) => rowsOf(line, columns))

// Where the window sits once it has caught the latest row: the first row of the tail
// when the Transcript is taller than the window, and the top when everything fits. This
// is the end a Following screen sits on; a Held offset is any point above it.
const pinned = (lines: ReadonlyArray<Line>, viewport: Viewport): number =>
  Math.max(0, laidOut(lines, viewport.columns).length - transcriptRows(viewport))

// Whether the window sits on that end, however it got there: the offset equalling the
// end `pinned` names is Following, and anything above it is Held. Both the append and
// the resize read the same question, which is why it is asked in one place.
const following = (screen: Screen): boolean =>
  screen.offset === pinned(screen.lines, screen.viewport)

// How many rows one wheel notch moves the window: far enough to be worth the gesture,
// close enough to keep your place.
const NOTCH = 3

// A notch is the one thing that can leave the latest line behind. Up moves toward the
// first line, down toward the latest, and a sideways roll is no scroll at all; either
// way the offset stays among the laid-out rows, and a Transcript that fits has nowhere
// to go.
const wheeled = (screen: Screen, notch: Notch): Step => {
  if (notch === 'sideways') {
    return { screen }
  }

  const end = pinned(screen.lines, screen.viewport)
  const moved = notch === 'up' ? screen.offset - NOTCH : screen.offset + NOTCH

  return { screen: { ...screen, offset: Math.min(end, Math.max(0, moved)) } }
}

// A line landing on the Transcript never yanks a reader who has left the latest line: a
// Following window is carried to the new end, where a Held offset stays exactly where it
// was, so the same lines remain in view as the new ones land below them.
const appended = (screen: Screen, line: Line): Screen => {
  const wasFollowing = following(screen)
  const lines = written(screen.lines, line)

  return {
    ...screen,
    lines,
    offset: wasFollowing ? pinned(lines, screen.viewport) : screen.offset,
  }
}

// A key does nothing while the Composer is Locked. Otherwise Return submits a non-blank
// Draft, backspace and delete take the last character, a chord or a key with no
// character of its own — an arrow, Page Up, Home — changes nothing, and anything else
// is a printable character landing at the end of the Draft.
const pressed = (
  screen: Screen,
  event: { readonly chord: Chord; readonly input: string },
): Step => {
  if (screen.locked) {
    return { screen }
  }

  const { chord, input } = event

  if (chord.return) {
    if (screen.draft.trim() === '') {
      return { screen }
    }

    const lines = written(screen.lines, { source: 'you', text: `> ${screen.draft}` })

    return {
      request: screen.draft,
      screen: {
        ...screen,
        draft: '',
        lines,
        locked: true,
        offset: pinned(lines, screen.viewport),
      },
    }
  }

  if (chord.backspace || chord.delete) {
    return { screen: { ...screen, draft: screen.draft.slice(0, -1) } }
  }

  if (chord.ctrl || chord.meta) {
    return { screen }
  }

  return { screen: { ...screen, draft: screen.draft + input } }
}

/**
 * Applies one event to the screen, yielding the next screen and any submitted Request.
 *
 * A key changes only the Draft. A wheel notch moves the window among the laid-out rows,
 * at any time. An Activity the screen shows appends to the Transcript; one it declines
 * to show adds nothing. An append while Following keeps the end in view and one while
 * Held leaves the offset alone, so a reader is not interrupted; a submit pins to the
 * end however far the reading had left it. The Turn ending — a rejection of the ask
 * included — unlocks the Composer, and the rejection is said in the loop's voice first.
 * A resize lays the Transcript out to the new window: a Following screen is carried to
 * the new end, and a Held one is clamped, resuming Following when the clamp lands on
 * that end.
 */
export const send = (screen: Screen, event: ScreenEvent): Step => {
  switch (event.type) {
    case 'key':
      return pressed(screen, event)

    case 'wheel':
      return wheeled(screen, event.notch)

    case 'activity': {
      const entry = transcribe(event.activity)

      return entry === undefined ? { screen } : { screen: appended(screen, entry) }
    }

    case 'ended':
      return { screen: { ...screen, locked: false } }

    case 'rejected':
      return {
        screen: { ...appended(screen, { source: 'loop', text: event.message }), locked: false },
      }

    case 'resize': {
      const end = pinned(screen.lines, event.viewport)

      return {
        screen: {
          ...screen,
          offset: following(screen) ? end : Math.min(screen.offset, end),
          viewport: event.viewport,
        },
      }
    }

    // Stryker disable next-line ConditionalExpression: every event has an arm above, so this one is reached only by a value the type rules out, and no test can build one without an assertion
    default:
      return casesHandled(event)
  }
}

/**
 * The cell the terminal cursor sits on, in the frame's own coordinates: 0-based columns
 * from the left edge and rows from the top edge of what the shell paints.
 */
export type Cell = {
  readonly column: number
  readonly row: number
}

/** What the shell paints: the Transcript's window, the Composer, and where the cursor goes. */
export type View = {
  readonly composer: string
  readonly cursor?: Cell
  readonly locked: boolean
  readonly rows: ReadonlyArray<Row>
}

// The visible slice of the Composer's content row: the tail that fits, so a Draft longer
// than the row slides and the end — where the next character lands — is never the part
// that is hidden. Cells, not characters: a wide glyph takes two columns off the row.
const tail = (text: string, width: number): string => {
  let kept = ''
  let taken = 0

  for (const point of Array.from(text).toReversed()) {
    const size = stringWidth(point)

    if (taken + size > width) {
      return kept
    }

    kept = point + kept
    taken += size
  }

  return kept
}

/**
 * Lays the screen out as a person sees it: the rows of the Transcript's window, the
 * Composer's one content row, whether that face is the Locked one, and the cursor cell
 * when there is a place to type. The shell paints this and decides nothing.
 */
export const view = (screen: Screen): View => {
  const window = transcriptRows(screen.viewport)

  const rows = laidOut(screen.lines, screen.viewport.columns).slice(
    screen.offset,
    screen.offset + window,
  )

  // Content cells are the columns the border leaves: the first and last belong to it.
  const width = Math.max(1, screen.viewport.columns - 2)
  const composer = tail(face(screen), width)

  if (screen.locked) {
    return { composer, locked: true, rows }
  }

  // The cursor sits just after the visible text, or on the last content cell once the
  // row has slid to its edge.
  const text = stringWidth(composer)

  return {
    composer,
    cursor: { column: text < width ? text + 1 : width, row: window + 2 },
    locked: false,
    rows,
  }
}
