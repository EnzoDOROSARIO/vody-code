import type { Notch } from './frame.ts'

/**
 * One input from the terminal, as far as the mouse is concerned: the notch when the
 * wheel rolled, or nothing to do for everything else the mouse sends — a click, a drag,
 * a sideways roll. `undefined` is not the mouse at all: it is a key.
 *
 * The shell reads the reports back because Ink has no mouse support. It hands them to
 * `useInput` as raw sequences, and one left unfiltered would land in the Draft as the
 * sequence it arrived as.
 */
export type Mouse = { readonly notch: Notch; readonly type: 'wheel' } | { readonly type: 'dropped' }

// The SGR mouse report the terminal sends once asked to track the mouse, as Ink hands it
// over: the leading escape is stripped off (`ink/build/hooks/use-input.js`), leaving
// `[<`, the button, the column and the row. A press ends `M` and a release `m`. Anchored
// so that a paste which happens to hold one is not read as the mouse.
const REPORT = /^\[<(\d+);\d+;\d+[Mm]$/

/** Reads one raw input as a mouse report, when it is one. */
export const mouse = (input: string): Mouse | undefined => {
  const report = REPORT.exec(input)

  if (report === null) {
    return undefined
  }

  // The button field carries the modifiers the roll was made with — shift 4, meta 8, and
  // ctrl 16 — beside the wheel's own code, so they are masked off: a modified roll is
  // still a roll. Any other button is a click, or the drag a held button makes.
  switch (Number(report[1]) & ~(4 | 8 | 16)) {
    case 64:
      return { notch: 'up', type: 'wheel' }
    case 65:
      return { notch: 'down', type: 'wheel' }
    case 66:
    case 67:
      return { notch: 'sideways', type: 'wheel' }
    default:
      return { type: 'dropped' }
  }
}
