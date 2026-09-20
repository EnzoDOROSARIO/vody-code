import { expect, test } from 'bun:test'

import { casesHandled } from '#defects.ts'

type Suit = 'hearts' | 'spades'

const drawn = (suit: Suit): string => {
  if (suit === 'hearts') {
    return '♥'
  }

  if (suit === 'spades') {
    return '♠'
  }

  return casesHandled(suit)
}

// A suit from outside the type system, which is the only way the branch is reached:
// the compiler has been told these are all the suits there are.
const dealt: Suit = JSON.parse('"clubs"')

test('an unhandled case throws, quoting what arrived', () => {
  expect(() => drawn(dealt)).toThrow('unhandled case: "clubs"')
})
