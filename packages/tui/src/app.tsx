import { Box, Text, useInput, useStdin } from 'ink'
import { useRef, useState } from 'react'

import { face, send, start } from './frame.ts'
import { Markdown } from './markdown/index.tsx'

import type { Activity } from 'agent'
import type { Line, Screen, ScreenEvent } from './frame.ts'
import type { ReactElement } from 'react'

export type Ask = (request: string, show: (activity: Activity) => void) => Promise<void>

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

/**
 * The Ink shell's painter: it draws the Composer's content row exactly as the frame
 * describes it, and decides nothing itself.
 */
export const Composer = ({ text }: { readonly text: string }): ReactElement => <Text>{text}</Text>

export const App = ({ ask }: { readonly ask: Ask }): ReactElement => {
  const { isRawModeSupported } = useStdin()
  const [screen, setScreen] = useState<Screen>(start)
  // The ask settles after the component has re-rendered, so the newest screen has to be
  // readable without one: an Activity that arrived while the last one was still being
  // painted would otherwise land on a stale screen.
  const latest = useRef<Screen>(start)

  const step = (event: ScreenEvent): string | undefined => {
    const { request, screen: next } = send(latest.current, event)

    latest.current = next
    setScreen(next)

    return request
  }

  const show = (activity: Activity): void => {
    step({ activity, type: 'activity' })
  }

  // Stryker disable next-line CallExpression: the hook attaches the handler to a terminal,
  // and a string render has no stdin to deliver a keystroke through — with the call or
  // without it the rendered screen is the same, which is why the rules live on the frame.
  useInput(
    (input, key) => {
      const request = step({ chord: key, input, type: 'key' })

      if (request === undefined) {
        return
      }

      // A Turn the model broke is an Activity like any other, so a rejection here is a
      // defect in the session, not an ending the transcript has a word for. It is said in
      // the loop's voice, and the Composer comes back either way, so nobody is left waiting
      // on a Turn that already ended.
      ask(request, show)
        .catch((error: Error) => step({ message: error.message, type: 'rejected' }))
        .finally(() => step({ type: 'ended' }))
    },
    // Stryker disable next-line ObjectLiteral: the option gates the handler on a terminal
    // being attached, which a string render never has, so with it or without it the
    // handler is inactive and no test can tell the two apart.
    { isActive: isRawModeSupported },
  )

  return (
    <Box flexDirection="column">
      <Transcript lines={screen.lines} />
      <Composer text={face(screen)} />
    </Box>
  )
}
