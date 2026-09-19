import { Box, Text, useInput, useStdin } from 'ink'
import { useState } from 'react'

import type { ReactElement } from 'react'

/**
 * Runs one question, writing each line the agent produces as it arrives and
 * resolving with the reply.
 */
export type Ask = (question: string, write: (line: string) => void) => Promise<string>

/** Everything said so far, oldest first. */
export const Transcript = ({ lines }: { readonly lines: ReadonlyArray<string> }): ReactElement => (
  <Box flexDirection="column">
    {lines.map((line, index) => (
      // Lines are append-only, so the index is a stable identity here.
      // oxlint-disable-next-line react/no-array-index-key -- append-only log
      <Text key={index}>{line}</Text>
    ))}
  </Box>
)

export const Prompt = ({
  busy,
  value,
}: {
  readonly busy: boolean
  readonly value: string
}): ReactElement => (busy ? <Text>…</Text> : <Text>{`> ${value}`}</Text>)

export const App = ({ ask }: { readonly ask: Ask }): ReactElement => {
  // Without a terminal there is no raw mode, and asking for keystrokes anyway
  // throws. The transcript still renders, which is what tests and pipes want.
  const { isRawModeSupported } = useStdin()
  const [lines, setLines] = useState<ReadonlyArray<string>>([])
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const write = (line: string): void => setLines((all) => [...all, line])

  const submit = (question: string): void => {
    setValue('')
    setBusy(true)
    write(`> ${question}`)

    ask(question, write)
      .then((reply) => write(reply))
      .catch((error: Error) => write(error.message))
      .finally(() => setBusy(false))
  }

  useInput(
    (input, key) => {
      if (busy) {
        return
      }

      if (key.return) {
        if (value.trim() !== '') {
          submit(value)
        }
      } else if (key.backspace || key.delete) {
        setValue((current) => current.slice(0, -1))
      } else if (!key.ctrl && !key.meta) {
        setValue((current) => current + input)
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
