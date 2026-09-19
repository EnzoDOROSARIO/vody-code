// Lines as a file holds them: a trailing newline ends the last line rather than
// starting an empty one.
export const toLines = (contents: string): ReadonlyArray<string> => {
  const split = contents.split('\n')

  return split.at(-1) === '' ? split.slice(0, -1) : split
}

export const numbered = (lines: ReadonlyArray<string>, first: number): string =>
  lines.map((line, index) => `${String(first + index).padStart(6, ' ')}→${line}`).join('\n')

export const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1
