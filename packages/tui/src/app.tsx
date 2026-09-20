import { Predicate } from 'effect'
import { Box, Text, useInput, useStdin } from 'ink'
import { useReducer, useState } from 'react'

import { casesHandled } from './defects.ts'
import { Markdown } from './markdown/index.tsx'

import type { Activity, ToolCall, ToolFailure, ToolResult } from 'agent'
import type { Key } from 'ink'
import type { ReactElement } from 'react'

export type Ask = (question: string, show: (activity: Activity) => void) => Promise<void>

/** Who put a line in the transcript, which is all its styling depends on. */
export type Source = 'agent' | 'call' | 'result' | 'you'

/**
 * One line of the transcript.
 *
 * A line the agent is still writing carries the id of the block of prose it holds, so
 * the next fragment of that block knows to land on the end of it. Everything else — a
 * question, a tool, a turn that broke — arrives whole and has no id to carry.
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

export const transcribe = (activity: Activity): Line | undefined => {
  if (activity.type === 'reply') {
    return { id: activity.id, source: 'agent', text: activity.text }
  }

  if (activity.type === 'tool-call') {
    return { source: 'call', text: asked(activity) }
  }

  const shown = gave(activity)

  return shown === undefined ? undefined : { source: 'result', text: shown }
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
  const [lines, write] = useReducer(written, [])
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const show = (activity: Activity): void => {
    const entry = transcribe(activity)

    if (entry !== undefined) {
      write(entry)
    }
  }

  const submit = (question: string): void => {
    setBusy(true)
    write({ source: 'you', text: `> ${question}` })

    ask(question, show)
      .catch((error: Error) => write({ source: 'agent', text: error.message }))
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
    { isActive: isRawModeSupported },
  )

  return (
    <Box flexDirection="column">
      <Transcript lines={lines} />
      <Prompt busy={busy} value={value} />
    </Box>
  )
}
