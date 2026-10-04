import { Box, Text, useCursor, useInput, useStdin, useStdout, useWindowSize } from 'ink'
import { useCallback, useEffect, useRef, useState } from 'react'

import { casesHandled } from './defects.ts'
import { send, start, transcriptRows, view } from './frame.ts'
import { eventOf } from './input.ts'

import type { Activity } from 'agent'
import type { Row, Screen, ScreenEvent } from './frame.ts'
import type { ReactElement } from 'react'

export type Ask = (request: string, show: (activity: Activity) => void) => Promise<void>

// One row as the terminal paints it. The frame has already decided what each row is —
// a Request, a tool, the loop's last word — and this only turns that into Ink's styling.
const Painted = ({ row }: { readonly row: Row }): ReactElement => {
  // A row with no words in it still takes its line: Ink drops a text node with nothing
  // in it, which would slide the dock up over the row the frame counted. A bare space
  // paints the row and is trimmed off the line; on a tool's slab it carries the grey
  // across the row's full width, the way the blank line inside a multi-line output does.
  const text = row.text === '' ? ' ' : row.text

  switch (row.source) {
    case 'loop':
      // The loop's last word on a Turn is set in bold, with none of a tool's grey, so it
      // reads as neither the model talking nor a tool's output.
      return <Text bold>{text}</Text>

    case 'call':
    case 'result':
      // A tool's output is a grey slab with dim text to sit back from the reply. The gap
      // above a call is none of these rows, so nothing paints it grey.
      return (
        <Box backgroundColor="gray">
          <Text dimColor>{text}</Text>
        </Box>
      )

    case 'agent':
    case 'gap':
    case 'you':
      return <Text>{text}</Text>

    // Stryker disable next-line ConditionalExpression: every Source has an arm above, so this one is reached only by a value the type rules out, and no test can build one without an assertion
    default:
      return casesHandled(row.source)
  }
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
      // oxlint-disable-next-line react/no-array-index-key -- rows are positional and Painted is stateless
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
 * placed at the cell the frame names, and hidden when the face is Locked, so Locked is
 * not a place that looks like typing could land.
 */
export const ScreenView = ({ screen }: { readonly screen: Screen }): ReactElement => {
  const shown = view(screen)
  const { setCursorPosition } = useCursor()

  // The hook syncs through an insertion effect, so the cell has to be handed over during
  // render; from an effect of our own it would land a paint late.
  // Stryker disable next-line CallExpression: the call hands the cell to Ink, and a string render never reads the cursor Ink keeps, so dropping it is invisible
  // Stryker disable next-line ConditionalExpression: the cell is handed to Ink, and a string render never reads the cursor it keeps, so the Locked choice is invisible
  // Stryker disable next-line ObjectLiteral: the cell is handed to Ink, and a string render never reads the object it keeps, so the object's shape is invisible
  setCursorPosition(shown.locked ? undefined : { x: shown.cursor.column, y: shown.cursor.row })

  return (
    <Box flexDirection="column" width={screen.viewport.columns}>
      <Transcript height={transcriptRows(screen.viewport)} rows={shown.rows} />
      <Text> </Text>
      <Composer locked={shown.locked} text={shown.composer} width={screen.viewport.columns} />
    </Box>
  )
}

export const App = ({ ask }: { readonly ask: Ask }): ReactElement => {
  const { isRawModeSupported } = useStdin()
  const { stdout } = useStdout()
  const window = useWindowSize()
  const [screen, setScreen] = useState<Screen>(() => start(window))
  // The ask settles after the component has re-rendered, so the newest screen has to be
  // readable without one: an Activity that arrived while the last one was still being
  // painted would otherwise land on a stale screen.
  const latest = useRef<Screen>(screen)

  // Stryker disable ArrayDeclaration: a string render never resizes, so the dependency
  // lists are never compared, whether they hold the window or not.
  // Stryker disable next-line BlockStatement: the callback runs only on a terminal event — a keystroke or a resize — and no test can deliver one
  const dispatch = useCallback((event: ScreenEvent): string | undefined => {
    const { request, screen: next } = send(latest.current, event)

    latest.current = next
    // Stryker disable next-line CallExpression: a state update is invisible to a string render, whose output is the first render
    setScreen(next)

    return request
  }, [])

  // A resize is the one window change that is not a key: Ink reports it, and the frame
  // lays the Transcript out to the new size, carrying a Following window to the new end
  // and clamping a Held one. No string render delivers a resize, so a render at the
  // window's size comes out the same with the call or without it, which is why the rule
  // lives on the frame.
  // Stryker disable next-line BlockStatement: the viewport already matches the window a string render reports, so emptying the resize step changes nothing
  // Stryker disable next-line CallExpression: the viewport already matches the window a string render reports, so dropping the effect call changes nothing
  useEffect(() => {
    dispatch({ type: 'resize', viewport: window })
  }, [dispatch, window])
  // Stryker restore ArrayDeclaration

  // The wheel is how the Transcript is read, and a terminal only sends its reports while
  // it is asked to track the mouse: the mode goes on with the shell and off with it, on
  // the same unmount Ctrl+C takes. A screen without raw mode is no terminal — a string
  // render included — and writing the mode to the process's own stream from one would
  // only leak the sequences.
  // Stryker disable ArrayDeclaration: a string render mounts the effect once and never re-renders, so its dependencies are never compared
  // Stryker disable BlockStatement: a string render has no terminal, so emptying the effect's body or its cleanup changes nothing the output carries
  // Stryker disable BooleanLiteral: flipping the guard writes to the process's own stream, which the render's output never carries
  // Stryker disable CallExpression: the write goes to the process's own stream, which the render's output never carries, so dropping either call is invisible
  // Stryker disable ConditionalExpression: the guard's branch only decides whether to write to the process's own stream, which the output never carries
  // Stryker disable StringLiteral: the sequence written goes to the process's own stream, which the render's output never carries
  useEffect(() => {
    if (!isRawModeSupported) {
      return undefined
    }

    stdout.write('\u001B[?1000h\u001B[?1006h')

    return () => {
      stdout.write('\u001B[?1000l\u001B[?1006l')
    }
  }, [isRawModeSupported, stdout])
  // Stryker restore ArrayDeclaration
  // Stryker restore BlockStatement
  // Stryker restore BooleanLiteral
  // Stryker restore CallExpression
  // Stryker restore ConditionalExpression
  // Stryker restore StringLiteral

  const show = (activity: Activity): void => {
    dispatch({ activity, type: 'activity' })
  }

  // A Turn the model broke is an Activity like any other, so a rejection here is a
  // defect in the session, not an ending the transcript has a word for. It is said in
  // the loop's voice, and the Composer comes back either way, so nobody is left waiting
  // on a Turn that already ended. No Request means no Turn: the event was a key or a
  // wheel notch, and nothing was submitted.
  const turned = (request: string | undefined): void => {
    if (request === undefined) {
      return
    }

    ask(request, show)
      .catch((error: Error) => dispatch({ message: error.message, type: 'rejected' }))
      .finally(() => dispatch({ type: 'ended' }))
  }

  // Stryker disable next-line CallExpression: the hook attaches the handler to a terminal,
  // and a string render has no stdin to deliver a keystroke through — with the call or
  // without it the rendered screen is the same, which is why the rules live on the frame.
  useInput(
    (input, key) => {
      const event = eventOf(input, key)

      if (event !== undefined) {
        turned(dispatch(event))
      }
    },
    // Stryker disable next-line ObjectLiteral: the option gates the handler on a terminal
    // being attached, which a string render never has, so with it or without it the
    // handler is inactive and no test can tell the two apart.
    { isActive: isRawModeSupported },
  )

  return <ScreenView screen={screen} />
}
