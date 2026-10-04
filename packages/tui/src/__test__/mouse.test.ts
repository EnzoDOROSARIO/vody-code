import { expect, it } from '@effect/vitest'

import { mouse } from '#mouse.ts'

// Ink hands every input to `useInput` as a string. A mouse report arrives as the SGR
// sequence the terminal sent, with its leading escape stripped: `[<` and the button,
// column and row, ending in `M` for a press. The wheel is buttons 64 and 65.
it('a wheel report is the notch it rolled', () => {
  expect(mouse('[<64;10;10M')).toEqual({ notch: 'up', type: 'wheel' })
  expect(mouse('[<65;10;10M')).toEqual({ notch: 'down', type: 'wheel' })
})

// A sideways roll is buttons 66 and 67: the mouse sent something, and it is not a scroll.
it('a sideways roll is a notch that scrolls nothing', () => {
  expect(mouse('[<66;10;10M')).toEqual({ notch: 'sideways', type: 'wheel' })
  expect(mouse('[<67;10;10M')).toEqual({ notch: 'sideways', type: 'wheel' })
})

// A click, a release, a drag: the mouse sent something and it is dropped, so a report
// never lands in the Draft as the raw sequence it arrived as.
it('anything else the mouse sends is dropped', () => {
  expect(mouse('[<0;10;10M')).toEqual({ type: 'dropped' })
  expect(mouse('[<0;10;10m')).toEqual({ type: 'dropped' })
  expect(mouse('[<32;10;10M')).toEqual({ type: 'dropped' })
})

// A keystroke is not the mouse: the shell leaves it to the frame as a key.
it('a key is not the mouse', () => {
  expect(mouse('a')).toBeUndefined()
  expect(mouse('')).toBeUndefined()
  expect(mouse('[<64;10M')).toBeUndefined()
})

// The report is read whole: a paste that carries one beside other text is not the mouse.
it('a report holding anything else is not a mouse report', () => {
  expect(mouse('x[<64;10;10M')).toBeUndefined()
  expect(mouse('[<64;10;10Mx')).toBeUndefined()
})
