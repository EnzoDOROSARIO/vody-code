import wrapAnsi from 'wrap-ansi'

// One string to the rows the terminal would paint for it, wrapped the way Ink wraps
// (`ink/build/wrap-text.js`), so a line the frame lays out takes exactly the rows a
// mounted Ink would have drawn. Trailing whitespace is trimmed off each row because Ink
// trims it off every painted line; whitespace inside a styled span survives either way,
// since the escape after it stops the trim.
//
// Both the Transcript's own lines and the markdown layout wrap through here: what Ink
// does to a line is one fact, and two copies of it would drift.
export const wrapped = (text: string, width: number): ReadonlyArray<string> =>
  wrapAnsi(text, Math.max(1, width), { hard: true, trim: false })
    .split('\n')
    .map((row) => row.trimEnd())
