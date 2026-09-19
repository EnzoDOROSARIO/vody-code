import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import { renderToString } from 'ink'

import { App, Prompt, Transcript, keystroke } from '#app.tsx'

import type { Chord } from '#app.tsx'

const chord = (pressed: Partial<Chord>): Chord => ({
  backspace: false,
  ctrl: false,
  delete: false,
  meta: false,
  return: false,
  ...pressed,
})

const RETURN = chord({ return: true })

const never: () => Promise<string> = () => Effect.runPromise(Effect.never)

test('the transcript renders each line above the prompt', () => {
  expect(renderToString(<Transcript lines={['> say hi', '$ echo hi', 'hi']} />)).toBe(
    '> say hi\n$ echo hi\nhi',
  )
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
