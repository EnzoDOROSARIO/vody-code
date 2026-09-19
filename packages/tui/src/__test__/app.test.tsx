import { expect, test } from 'bun:test'
import chalk from 'chalk'
import { Effect } from 'effect'
import { Response } from 'effect/unstable/ai'
import { renderToString } from 'ink'

import { App, Prompt, Transcript, keystroke, transcribe } from '#app.tsx'

import { CommandRefused } from 'agent'

import type { ToolResult } from 'agent'
import type { Line } from '#app.tsx'
import type { Chord } from '#app.tsx'
import type { ReactElement } from 'react'

const chord = (pressed: Partial<Chord>): Chord => ({
  backspace: false,
  ctrl: false,
  delete: false,
  meta: false,
  return: false,
  ...pressed,
})

const RETURN = chord({ return: true })

const never: () => Promise<void> = () => Effect.runPromise(Effect.never)

const GREY_BACKGROUND = '\u001B[100m'

const DIM = '\u001B[2m'

// Ink paints through chalk, which keeps quiet when nothing on the other end is a
// terminal. Turning it up around one render is the only way to see what a real one
// gets, and the render is synchronous, so nothing else observes the raised level.
//
// This only works while `chalk` here resolves to the copy Ink paints with. Should the
// two ever part — Ink moving to a major this package does not follow — the render
// comes back bare, so the check below names that cause instead of leaving the
// assertions underneath to fail as if the styling had been dropped.
const colourful = (node: ReactElement): string => {
  const level = chalk.level

  chalk.level = 3

  try {
    const painted = renderToString(node)

    if (!painted.includes('\u001B[')) {
      throw new Error('chalk painted nothing: this package and ink hold separate copies')
    }

    return painted
  } finally {
    chalk.level = level
  }
}

const transcript: ReadonlyArray<Line> = [
  { source: 'you', text: '> say hi' },
  { source: 'call', text: '$ echo hi' },
  { source: 'agent', text: 'hi' },
]

const ranBash: ToolResult = Response.toolResultPart({
  encodedResult: 'exit 0\nhi',
  id: 'call-1',
  isFailure: false,
  name: 'bash',
  preliminary: false,
  providerExecuted: false,
  result: 'exit 0\nhi',
})

const readFile: ToolResult = Response.toolResultPart({
  encodedResult: 'the whole file',
  id: 'call-2',
  isFailure: false,
  name: 'read_file',
  preliminary: false,
  providerExecuted: false,
  result: 'the whole file',
})

test('each tool call is announced in the wording that suits it', () => {
  expect(
    transcribe({ id: 'c', name: 'bash', params: { command: 'echo hi' }, type: 'tool-call' }),
  ).toEqual({ source: 'call', text: '$ echo hi' })
  expect(
    transcribe({ id: 'c', name: 'read_file', params: { path: 'a.ts' }, type: 'tool-call' }),
  ).toEqual({ source: 'call', text: 'read a.ts' })
  expect(
    transcribe({
      id: 'c',
      name: 'write_file',
      params: { content: 'x', path: 'a.ts' },
      type: 'tool-call',
    }),
  ).toEqual({ source: 'call', text: 'write a.ts' })
  expect(
    transcribe({
      id: 'c',
      name: 'edit_file',
      params: { new_text: 'b', old_text: 'a', path: 'a.ts' },
      type: 'tool-call',
    }),
  ).toEqual({ source: 'call', text: 'edit a.ts' })
  expect(
    transcribe({ id: 'c', name: 'glob', params: { pattern: '*.ts' }, type: 'tool-call' }),
  ).toEqual({ source: 'call', text: 'glob *.ts' })
})

test('bash quotes its output back, exit status first, and the others stay quiet', () => {
  expect(transcribe(ranBash)).toEqual({ source: 'result', text: 'exit 0\nhi' })
  expect(transcribe(readFile)).toBeUndefined()
})

test('a tool that failed says which tool, and why', () => {
  const refused: ToolResult = Response.toolResultPart({
    encodedResult: {},
    id: 'call-3',
    isFailure: true,
    name: 'bash',
    preliminary: false,
    providerExecuted: false,
    result: new CommandRefused({ reason: 'rm -rf is not allowed here' }),
  })

  expect(transcribe(refused)).toEqual({
    source: 'result',
    text: 'bash failed: rm -rf is not allowed here',
  })
})

test('a call the agent never ran says so in the same breath', () => {
  const denied: ToolResult = Response.toolResultPart({
    encodedResult: {},
    id: 'call-4',
    isFailure: true,
    name: 'write_file',
    preliminary: false,
    providerExecuted: false,
    result: { reason: 'the user said no', type: 'execution-denied' },
  })

  expect(transcribe(denied)).toEqual({
    source: 'result',
    text: 'write_file failed: the user said no',
  })
})

test('the reply is the agent speaking, not a tool', () => {
  expect(transcribe({ type: 'reply', text: 'done' })).toEqual({ source: 'agent', text: 'done' })
})

test('the transcript renders each line above the prompt', () => {
  expect(renderToString(<Transcript lines={transcript} />)).toBe('> say hi\n\n$ echo hi\nhi')
})

test('a tool line carries a grey background and dim text, and the rest carry neither', () => {
  const [you, , call, agent] = colourful(<Transcript lines={transcript} />).split('\n')

  expect(call).toContain(GREY_BACKGROUND)
  expect(call).toContain(DIM)
  expect(you).toBe('> say hi')
  expect(agent).toBe('hi')
})

test('a chain of calls is broken up, while a call keeps the output under it', () => {
  const chained: ReadonlyArray<Line> = [
    { source: 'call', text: '$ echo hi' },
    { source: 'result', text: 'exit 0' },
    { source: 'result', text: 'hi' },
    { source: 'call', text: 'read a.ts' },
  ]

  expect(renderToString(<Transcript lines={chained} />)).toBe(
    '\n$ echo hi\nexit 0\nhi\n\nread a.ts',
  )
})

test('the gap above a call is bare, not another row of grey', () => {
  const [, gap] = colourful(<Transcript lines={transcript} />).split('\n')

  expect(gap).toBe('')
})

test('the prompt shows what has been typed so far', () => {
  expect(renderToString(<Prompt busy={false} value="who am I" />)).toBe('> who am I')
})

test('the prompt waits while the agent is working', () => {
  expect(renderToString(<Prompt busy value="" />)).toBe('…')
})

test('the app starts with an empty transcript and an empty prompt', () => {
  expect(renderToString(<App ask={never} />)).toBe('>')
})

test('a printable key lands at the end of what is typed', () => {
  expect(keystroke(false, chord({}), 'i', 'h')).toEqual({ submit: false, value: 'hi' })
})

test('backspace and delete each take the last character back', () => {
  expect(keystroke(false, chord({ backspace: true }), '', 'hi')).toEqual({
    submit: false,
    value: 'h',
  })
  expect(keystroke(false, chord({ delete: true }), '', 'hi')).toEqual({
    submit: false,
    value: 'h',
  })
})

test('backspace on an empty prompt leaves it empty', () => {
  expect(keystroke(false, chord({ backspace: true }), '', '')).toEqual({ submit: false, value: '' })
})

test('return submits what is typed and clears the prompt', () => {
  expect(keystroke(false, RETURN, '', 'who am I')).toEqual({ submit: true, value: '' })
})

test('return on blank input submits nothing and keeps the blank', () => {
  expect(keystroke(false, RETURN, '', '   ')).toEqual({ submit: false, value: '   ' })
  expect(keystroke(false, RETURN, '', '')).toEqual({ submit: false, value: '' })
})

test('a modifier chord types nothing', () => {
  expect(keystroke(false, chord({ ctrl: true }), 'c', 'hi')).toEqual({ submit: false, value: 'hi' })
  expect(keystroke(false, chord({ meta: true }), 'v', 'hi')).toEqual({ submit: false, value: 'hi' })
})

test('every key is ignored while the agent is working', () => {
  expect(keystroke(true, chord({}), 'x', 'hi')).toEqual({ submit: false, value: 'hi' })
  expect(keystroke(true, RETURN, '', 'hi')).toEqual({ submit: false, value: 'hi' })
  expect(keystroke(true, chord({ backspace: true }), '', 'hi')).toEqual({
    submit: false,
    value: 'hi',
  })
})
