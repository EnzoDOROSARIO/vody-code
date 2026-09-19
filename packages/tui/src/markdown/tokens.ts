import { Marked } from 'marked'

import type { MarkedToken, Token, Tokens } from 'marked'

// `marked.use` mutates a module-global singleton that every other caller in the process
// shares, which is how two components with different options end up racing. An instance
// of its own keeps both changes below inside this module.
//
// Strikethrough is off because the model writes `~` far more often to mean "about" —
// `~100ms` — than it writes `~~` to strike something out, and the tokenizer reads the
// first as the second across the rest of the line.
export const reader = new Marked({ gfm: true })

reader.use({ tokenizer: { del: () => undefined } })

// `Token` ends in `Tokens.Generic`, whose `type` is a bare `string` and whose index
// signature answers to any property name at all. That one member keeps a match on
// `type` from narrowing to a single interface, so every arm that draws a token would
// read its fields through the index signature rather than through the shape marked
// documents. Naming the types marked itself produces puts the union back; a plugin's
// own token, which this module has not been taught to draw, falls through to its raw
// text.
//
// `del` and `list_item` are left out, and `Drawable` drops them from the union to match.
// The strikethrough tokenizer is turned off above, so no `del` token is ever produced;
// and a list item is reached through its list's `items`, never through any token's
// `tokens`, so nothing is ever handed one. An arm for either would be one no input
// can reach, and an arm no input reaches is one nothing can hold to its word.
/** A token this module draws: what marked produces, less the two it cannot hand over. */
export type Drawable = Exclude<MarkedToken, Tokens.Del | Tokens.ListItem>

// The same names the arm table in `render.ts` is keyed by, and a record rather than a
// set so that the compiler holds the two halves of one decision together: this
// annotation rejects a name that is not a member of `Drawable` and a member left out of
// it, and `Match.discriminatorsExhaustive` holds the arms to that same union. Neither
// half can drift from the other across the file boundary without a type error, which
// matters because the two failures are silent in opposite ways — a name missing here
// quietly renders the token as raw markdown, and a name here with no arm throws
// mid-render.
const DRAWN: Record<Drawable['type'], true> = {
  blockquote: true,
  br: true,
  checkbox: true,
  code: true,
  codespan: true,
  def: true,
  em: true,
  escape: true,
  heading: true,
  hr: true,
  html: true,
  image: true,
  link: true,
  list: true,
  paragraph: true,
  space: true,
  strong: true,
  table: true,
  text: true,
}

export const parsed = (token: Token): token is Drawable => Object.hasOwn(DRAWN, token.type)

export const listed = (token: Token): token is Tokens.List => parsed(token) && token.type === 'list'

export const quotation = (token: Token): token is Tokens.Blockquote =>
  parsed(token) && token.type === 'blockquote'
