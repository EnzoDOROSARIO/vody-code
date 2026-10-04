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
// shell prompt is the Transcript's business, and every tool gets the phrasing that
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

// A Turn that reached an Impasse hands the Composer back just as one that answered does,
// so the line has to say it is over and why, or the person sits waiting for an answer
// that is not coming. The refusals themselves are the lines above it, each with its
// reasons.
const stopped = (impasse: Impasse): string =>
  ended(
    `the Gates refused ${impasse.refusals} acts with none allowed in between, so the agent stopped trying`,
    'Ask again another way',
  )

// A Turn the model broke ends the same way, and the line says why in the words the
// failure gave it: nothing the model wrote after the break is coming either.
const broke = (breakdown: Breakdown): string =>
  ended(`the model broke down — ${breakdown.reason}`, 'Ask again')

/** One Activity as the Transcript says it, or nothing when the screen declines it. */
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
