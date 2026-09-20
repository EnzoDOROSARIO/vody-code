import { expect, test } from 'bun:test'

import { toolkit } from '#tools/index.ts'

// A tool's description is the whole of what the model is told about it: there is no
// other documentation it can go and read. That makes the wording part of the agent's
// behaviour rather than a comment on it, so it is pinned here in full — a change to
// what the model is told is a change to be made on purpose and reviewed as one.
test('the tools describe themselves to the model in these words', () => {
  expect(
    Object.fromEntries(
      Object.entries(toolkit.tools).map(([name, tool]) => [name, tool.description]),
    ),
  ).toEqual({
    bash: [
      'Run a shell command. The first line of the result is `exit <code>`. The rest is the command',
      'output, stdout and stderr interleaved — except that output which ran long is cut from the',
      'front to keep the end, and then the line after `exit <code>` says how much went and names a',
      'file holding all of it, which you can read or grep. Each call starts a fresh shell, so `cd`',
      'and exported variables do not carry over — write `cd x && y` in one command instead. stdin is',
      'closed, so a command that would prompt reads end-of-file instead of hanging. The command is',
      'killed after timeout_seconds, 120 by default and at most 600.',
    ].join(' '),
    edit_file: [
      'Replace text in file. `old_text` must appear exactly once: when it appears more often the',
      'edit is refused, so extend it with surrounding lines until it identifies one place, or pass',
      '`replace_all` to change every occurrence. Both texts are matched and inserted literally.',
      'The result shows the edited lines with their numbers.',
    ].join(' '),
    glob: [
      'Find files matching a glob pattern; ** matches recursively. Returns files only, most recently',
      'modified first, so the useful matches come first when the list is cut short. Anything',
      'gitignored is skipped, along with .git, node_modules and dist — unless the pattern names one',
      'of those directly.',
    ].join(' '),
    read_file: [
      'Read file contents. Each line is prefixed with its number and an arrow, as in `     1→text`;',
      'that prefix is not part of the file, so never copy it into edit_file. Reads from `offset`',
      "(the first line, counting from 1) and stops after `limit` lines, saying what it didn't show",
      'and the offset to continue from. Long results are cut to a character budget as well, so a',
      'file of very long lines comes back clipped.',
    ].join(' '),
    write_file: [
      'Write content to file, creating any missing parent directories. Writing over a file that',
      'already exists requires having read all of it first, so that what is replaced is known; a',
      'read that was cut short by offset, limit or the character budget does not count. To change',
      'part of a file, prefer edit_file, which needs no prior read.',
    ].join(' '),
  })
})
