import { Predicate } from 'effect'

import { casesHandled } from './defects.ts'

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
// worth them. Anything narrower would mean reading a shape the agent composed for
// the model, which is the coupling this screen exists to avoid.
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

/**
 * Everything the screen knows: the lines of the Transcript, the Draft in the Composer,
 * and whether the Composer is Locked for a Turn in flight.
 */
export type Screen = {
  readonly draft: string
  readonly lines: ReadonlyArray<Line>
  readonly locked: boolean
}

/**
 * One thing that happens to the screen: a key, an Activity the Turn reported, the Turn
 * ending, or the ask itself being rejected.
 */
export type ScreenEvent =
  | { readonly chord: Chord; readonly input: string; readonly type: 'key' }
  | { readonly activity: Activity; readonly type: 'activity' }
  | { readonly type: 'ended' }
  | { readonly message: string; readonly type: 'rejected' }

/** What one event does: the next screen, and the Request when a submit happened. */
export type Step = {
  readonly request?: string
  readonly screen: Screen
}

/** The screen before anyone has typed or the agent has said anything. */
export const start: Screen = { draft: '', lines: [], locked: false }

/**
 * The Composer's content row. The idle face is the chevron and the Draft, which is the
 * same shape the Transcript keeps for a submitted Request. The Locked face is a still
 * ellipsis with no chevron.
 */
export const face = (screen: Screen): string => (screen.locked ? '…' : `> ${screen.draft}`)

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

    return {
      request: screen.draft,
      screen: {
        draft: '',
        lines: written(screen.lines, { source: 'you', text: `> ${screen.draft}` }),
        locked: true,
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
 * An Activity the screen shows appends to the Transcript; one it declines to show adds
 * nothing. Neither moves a Locked Composer. The Turn ending — a rejection of the ask
 * included — unlocks it, and the rejection is said in the loop's voice first.
 */
export const send = (screen: Screen, event: ScreenEvent): Step => {
  switch (event.type) {
    case 'key':
      return pressed(screen, event)

    case 'activity': {
      const entry = transcribe(event.activity)

      return entry === undefined
        ? { screen }
        : { screen: { ...screen, lines: written(screen.lines, entry) } }
    }

    case 'ended':
      return { screen: { ...screen, locked: false } }

    case 'rejected':
      return {
        screen: {
          ...screen,
          lines: written(screen.lines, { source: 'loop', text: event.message }),
          locked: false,
        },
      }
    // Stryker disable next-line ConditionalExpression: every event has an arm above, so this one is reached only by a value the type rules out, and no test can build one without an assertion
    default:
      return casesHandled(event)
  }
}
