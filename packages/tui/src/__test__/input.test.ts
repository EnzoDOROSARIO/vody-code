import { expect, it } from '@effect/vitest'

import { eventOf } from '#input.ts'

import type { Chord } from '#frame.ts'

// What Ink hands `useInput` for a key: the character typed, and the chords held down.
// Every chord is spelled out so a test that presses none of them says so.
const chord = (pressed: Partial<Chord>): Chord => ({
  backspace: false,
  ctrl: false,
  delete: false,
  meta: false,
  return: false,
  ...pressed,
})

// A mouse report is already the frame's event: the wheel's notch.
it('a mouse report is the event it names', () => {
  expect(eventOf('[<64;10;10M', chord({}))).toEqual({ notch: 'up', type: 'wheel' })
  expect(eventOf('[<65;10;10M', chord({}))).toEqual({ notch: 'down', type: 'wheel' })
  expect(eventOf('[<66;10;10M', chord({}))).toEqual({ notch: 'sideways', type: 'wheel' })
})

// A click or a drag is the mouse and nothing else: no event at all, so the shell drops
// it rather than handing the raw sequence on as a key.
it('a mouse report with nothing to do is no event', () => {
  expect(eventOf('[<0;10;10M', chord({}))).toBeUndefined()
  expect(eventOf('[<0;10;10m', chord({}))).toBeUndefined()
  expect(eventOf('[<32;10;10M', chord({}))).toBeUndefined()
})

// Anything that is not a report is a key: the chord and the character are the frame's
// key event, exactly as Ink handed them over.
it('a key is the key event the frame reads', () => {
  expect(eventOf('i', chord({}))).toEqual({ chord: chord({}), input: 'i', type: 'key' })
  expect(eventOf('\r', chord({ return: true }))).toEqual({
    chord: chord({ return: true }),
    input: '\r',
    type: 'key',
  })
})
