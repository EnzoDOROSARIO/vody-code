import { Box, Text, useInput, useStdin } from 'ink'
import { useState } from 'react'

import type { Key } from 'ink'
import type { ReactElement } from 'react'

export type Ask = (question: string, write: (line: string) => void) => Promise<string>

export const Transcript = ({ lines }: { readonly lines: ReadonlyArray<string> }): ReactElement => (
  <Box flexDirection="column">
    {lines.map((line, index) => (
      // oxlint-disable-next-line react/no-array-index-key -- append-only log
      <Text key={index}>{line}</Text>
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
  const [lines, setLines] = useState<ReadonlyArray<string>>([])
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const write = (line: string): void => setLines((all) => [...all, line])

  const submit = (question: string): void => {
    setBusy(true)
    write(`> ${question}`)

    ask(question, write)
      .then((reply) => write(reply))
      .catch((error: Error) => write(error.message))
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
