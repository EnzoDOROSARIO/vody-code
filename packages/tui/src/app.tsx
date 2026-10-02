import { Predicate } from 'effect'
import { Box, Text, useInput, useStdin } from 'ink'
import { useReducer, useState } from 'react'

import { casesHandled } from './defects.ts'
import { Markdown } from './markdown/index.tsx'

import type { Activity, Breakdown, Impasse, ToolCall, ToolFailure, ToolResult } from 'agent'
import type { Key } from 'ink'
import type { ReactElement } from 'react'

export type Ask = (request: string, show: (activity: Activity) => void) => Promise<void>

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

// A terminal has one font, so a tool's output is set apart the only two ways the
// terminal offers: a grey slab behind it, and dim text to sit back from the reply.
// The Box pads to the full width, so a call and the output under it read as one block.
//
// The blank row above a call is what keeps the next tool from joining that block: one
// chain of tools would otherwise arrive as a single slab with no seam to read it by.
// It is a margin rather than an empty line so that nothing paints it grey.
//
// Only the agent writes markdown. What you typed is shown back exactly as typed, and a
// tool's output is already the text some other program chose.
const Entry = ({ line }: { readonly line: Line }): ReactElement => {
  if (line.source === 'agent') {
    return <Markdown>{line.text}</Markdown>
  }

  if (line.source === 'you') {
    return <Text>{line.text}</Text>
  }

  // The loop's last word on a Turn is set in bold, with none of a tool's grey, so it
  // reads as neither the model talking nor a tool's output.
  if (line.source === 'loop') {
    return <Text bold>{line.text}</Text>
  }

  return (
    <Box backgroundColor="gray" marginTop={line.source === 'call' ? 1 : 0}>
      <Text dimColor>{line.text}</Text>
    </Box>
  )
}

export const Transcript = ({ lines }: { readonly lines: ReadonlyArray<Line> }): ReactElement => (
  <Box flexDirection="column">
    {lines.map((entry, index) => (
      // oxlint-disable-next-line react/no-array-index-key -- append-only log
      <Entry key={index} line={entry} />
    ))}
  </Box>
)

export type Chord = Pick<Key, 'backspace' | 'ctrl' | 'delete' | 'meta' | 'return'>

export type Keystroke = {
  readonly submit: boolean
  readonly value: string
}

export const keystroke = (busy: boolean, chord: Chord, input: string, value: string): Keystroke => {
  if (busy) {
    return { submit: false, value }
  }

  if (chord.return) {
    return value.trim() === '' ? { submit: false, value } : { submit: true, value: '' }
  }

  if (chord.backspace || chord.delete) {
    return { submit: false, value: value.slice(0, -1) }
  }

  if (chord.ctrl || chord.meta) {
    return { submit: false, value }
  }

  return { submit: false, value: value + input }
}

export const Prompt = ({
  busy,
  value,
}: {
  readonly busy: boolean
  readonly value: string
}): ReactElement => (busy ? <Text>…</Text> : <Text>{`> ${value}`}</Text>)

export const App = ({ ask }: { readonly ask: Ask }): ReactElement => {
  const { isRawModeSupported } = useStdin()
  // Stryker disable next-line ArrayDeclaration: the seed is a transcript nobody typed yet,
  // and it can only be seen through `Entry`, which reads a seeded non-line's `text` as
  // undefined and paints nothing, while `written` appends on a missing id without ever
  // reading the seed's shape — no render can tell a seeded transcript from an empty one.
  const [lines, write] = useReducer(written, [])
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const show = (activity: Activity): void => {
    const entry = transcribe(activity)

    if (entry !== undefined) {
      write(entry)
    }
  }

  const submit = (request: string): void => {
    setBusy(true)
    write({ source: 'you', text: `> ${request}` })

    // A Turn the model broke is an Activity like any other, so a rejection here is a
    // defect in the session, not an ending the transcript has a word for. It is said in
    // the loop's voice, and the prompt comes back either way, so nobody is left waiting
    // on a Turn that already ended.
    ask(request, show)
      .catch((error: Error) => write({ source: 'loop', text: error.message }))
      .finally(() => setBusy(false))
  }

  useInput(
    (input, key) => {
      const next = keystroke(busy, key, input, value)

      setValue(next.value)

      if (next.submit) {
        submit(value)
      }
    },
    // Stryker disable next-line ObjectLiteral: the option gates the handler on a terminal
    // being attached, which a string render never has, so with it or without it the
    // handler is inactive and no test can tell the two apart.
    { isActive: isRawModeSupported },
  )

  return (
    <Box flexDirection="column">
      <Transcript lines={lines} />
      <Prompt busy={busy} value={value} />
    </Box>
  )
}
