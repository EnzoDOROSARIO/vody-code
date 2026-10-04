import { mouse } from './mouse.ts'

import type { Chord, ScreenEvent } from './frame.ts'

/**
 * One raw input as the frame's event: a mouse report already names its notch, a key is
 * handed over as the key it is, and a report the frame declines — a click, a drag, a
 * sideways roll — is nothing, so the shell drops it rather than letting the raw sequence
 * land in the Draft.
 */
export const eventOf = (input: string, key: Chord): ScreenEvent | undefined => {
  const report = mouse(input)

  if (report?.type === 'dropped') {
    return undefined
  }

  return report ?? { chord: key, input, type: 'key' }
}
