import { Box, Text, useCursor, useInput, useStdin, useWindowSize } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { send, start, transcriptRows, view } from './frame.ts'

import type { Activity } from 'agent'
import type { Row, Screen, ScreenEvent } from './frame.ts'
import type { ReactElement } from 'react'

export type Ask = (request: string, show: (activity: Activity) => void) => Promise<void>

// One row as the terminal paints it. The frame has already decided what each row is —
// a Request, a tool, the loop's last word — and this only turns that into Ink's styling,
// the same way the old Transcript did.
const Painted = ({ row }: { readonly row: Row }): ReactElement => {
  // A row with no words in it still takes its line: Ink drops a text node with nothing
  // in it, which would slide the dock up over the row the frame counted. A bare space
  // paints the row and is trimmed off the line; on a tool's slab it carries the grey
  // across the row's full width, the way the blank line inside a multi-line output does.
  const text = row.text === '' ? ' ' : row.text

  // The loop's last word on a Turn is set in bold, with none of a tool's grey, so it
  // reads as neither the model talking nor a tool's output.
  if (row.source === 'loop') {
    return <Text bold>{text}</Text>
  }

  // A tool's output is a grey slab with dim text to sit back from the reply. The gap
  // above a call is none of these rows, so nothing paints it grey.
  if (row.source === 'call' || row.source === 'result') {
    return (
      <Box backgroundColor="gray">
        <Text dimColor>{text}</Text>
      </Box>
    )
  }

  return <Text>{text}</Text>
}

/**
 * The Transcript's window: the rows the frame laid out, top-aligned inside the rows the
 * dock left. The height is the frame's, not the rows', so a short Transcript keeps the
 * dock on the last rows with the gap above it.
 */
const Transcript = ({
  height,
  rows,
}: {
  readonly height: number
  readonly rows: ReadonlyArray<Row>
}): ReactElement => (
  <Box flexDirection="column" height={height}>
    {rows.map((row, index) => (
      // oxlint-disable-next-line react/no-array-index-key -- append-only log
      <Painted key={index} row={row} />
    ))}
  </Box>
)

/**
 * The dock's framed one-line box. The frame hands over the slice of the content row
 * that fits inside it and whether that face is Locked; the shell draws the border and
 * dims the waiting face, deciding nothing itself.
 */
const Composer = ({
  locked,
  text,
  width,
}: {
  readonly locked: boolean
  readonly text: string
  readonly width: number
}): ReactElement => (
  <Box borderStyle="single" height={3} width={width}>
    {locked ? <Text dimColor>{text}</Text> : <Text>{text}</Text>}
  </Box>
)

/**
 * The screen as the frame describes it: the Transcript's window, the blank seam that
 * never scrolls, and the framed Composer pinned under both. The terminal cursor is
 * placed at the cell the frame names, and hidden when it names none, so Locked is not
 * a place that looks like typing could land.
 */
export const ScreenView = ({ screen }: { readonly screen: Screen }): ReactElement => {
  const { composer, cursor, locked, rows } = view(screen)
  const { setCursorPosition } = useCursor()

  // The hook syncs through an insertion effect, so the cell has to be handed over during
  // render; from an effect of our own it would land a paint late.
  // Stryker disable next-line ConditionalExpression,ObjectLiteral: the cell is handed to Ink, and a string render never reads the cursor it keeps
  setCursorPosition(cursor === undefined ? undefined : { x: cursor.column, y: cursor.row })

  return (
    <Box flexDirection="column" width={screen.viewport.columns}>
      <Transcript height={transcriptRows(screen.viewport)} rows={rows} />
      <Text> </Text>
      <Composer locked={locked} text={composer} width={screen.viewport.columns} />
    </Box>
  )
}

export const App = ({ ask }: { readonly ask: Ask }): ReactElement => {
  const { isRawModeSupported } = useStdin()
  const window = useWindowSize()
  const [screen, setScreen] = useState<Screen>(() => start(window))
  // The ask settles after the component has re-rendered, so the newest screen has to be
  // readable without one: an Activity that arrived while the last one was still being
  // painted would otherwise land on a stale screen.
  const latest = useRef<Screen>(screen)

  // Stryker disable ArrayDeclaration: the dependency lists below hold only a ref, a setter
  // and the window, which React keeps stable; no string render can vary them.
  // Stryker disable next-line BlockStatement: the callback runs only on a terminal event — a keystroke or a resize — and no test can deliver one
  const step = useCallback((event: ScreenEvent): string | undefined => {
    const { request, screen: next } = send(latest.current, event)

    latest.current = next
    // Stryker disable next-line CallExpression: a state update is invisible to a string render, whose output is the first render
    setScreen(next)

    return request
  }, [])

  // A resize is the one window change that is not a key: Ink reports it, and the frame
  // lays the Transcript out to the new size and puts the window back at the end. No
  // string render delivers a resize, so a render at the window's size comes out the same
  // with the call or without it, which is why the rule lives on the frame.
  // Stryker disable next-line BlockStatement,CallExpression: the effect attaches to the terminal, and no test can resize one
  useEffect(() => {
    step({ type: 'resize', viewport: window })
  }, [step, window])
  // Stryker restore ArrayDeclaration

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

  return <ScreenView screen={screen} />
}
