// The test set Stryker's mutation run executes: the unit tests alone, loaded by the
// vitest runner through `vitest.configFile` in stryker.config.mjs. A unit test is one
// that runs with nothing of the machine behind it — no filesystem, no git, no child
// process, no network — so a mutant is paid for in memory-only work, and the whole run
// takes about half a minute. The suites that mount real infrastructure — the tools, the
// Gates, the loop over real handlers, everything the harnesses in
// packages/agent/src/__test__/testing.ts build — are not here, and neither is their code
// in the mutate set: its assurance is the suites that run it for real, and the way to
// put that code under mutation is to make its tests unit first.
//
// The main suite (vite.config.ts) keeps every test; this file is read only by the
// mutation run.
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Pinned to this file's directory, as vite.config.ts pins its own, so the include
  // patterns resolve the same way from any working directory.
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    environment: 'node',
    include: [
      // The screen and its markdown, rendered with Ink's renderToString: no terminal,
      // no timers, nothing written anywhere.
      'packages/tui/src/__test__/app.test.tsx',
      'packages/tui/src/__test__/defects.test.ts',
      'packages/tui/src/markdown/__test__/markdown.test.tsx',
      // The loop's own behaviour: the model scripted at the top seam and the tools
      // answering from cans behind the seam's hooks, so no file is touched, no git is
      // walked, and no command is run — the counting, the fragments, the Request's flow,
      // and the Verdict a Gate derives, all in memory.
      'packages/agent/src/__test__/index.test.ts',
      'packages/agent/src/__test__/refusals.test.ts',
      'packages/agent/src/__test__/request.test.ts',
      'packages/agent/src/__test__/verdict.test.ts',
      // Pure seam-work beside the tools: their descriptions, and the Passage the seam
      // records, in memory.
      'packages/agent/src/tools/__test__/descriptions.test.ts',
      'packages/agent/src/tools/__test__/passage.test.ts',
      'packages/agent/src/__test__/workspace.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/repos/**', '**/dist/**'],
  },
})
