// Defects: the things that cannot happen unless the code is wrong. Each one throws,
// because there is no recovery a caller could reasonably choose.

/**
 * Closes an exhaustive branch on a union. Reaching it means the union gained a member
 * the branch above does not name, which the compiler rejects first.
 *
 * @throws Always — every case a caller can construct is handled before this one.
 */
export const casesHandled = (unhandled: never): never => {
  throw new Error(`unhandled case: ${JSON.stringify(unhandled)}`)
}
