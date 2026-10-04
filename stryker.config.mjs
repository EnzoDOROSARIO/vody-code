// The vitest runner gives Stryker real per-test coverage analysis: each mutant
// narrows to the tests that reach it, not for a whole suite per mutant — what the
// command runner this config replaced under bun could only report a run at a time,
// because bun's test runner has no Stryker plugin.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  coverageAnalysis: 'perTest',

  // The mutation run is a unit gate: it executes the tests of vitest.mutation.config.ts,
  // the ones that need no filesystem, no git, no child process, no network, and the
  // mutate set is what those tests reach — the TUI's sources, and the loop's own logic
  // (the Turn's stream, the Activities, the Request, the Passage the seam records, the
  // Verdict a Gate derives), whose tests run it with the model scripted and the tools
  // answering from cans. A mutant is paid for in memory-only work, so the run costs
  // about half a minute. Code only the infra suites reach (the tools' own effects, the
  // Gates over real disk, the session that reads the workspace's instructions) is not
  // mutated here: its assurance is the suites that run it for real, and the way to put
  // it under mutation is to make its tests unit first, which grows this set by the same
  // stroke.
  mutate: [
    'packages/tui/src/**/*.ts',
    'packages/tui/src/**/*.tsx',
    '!packages/tui/src/**/__test__/**',
    'packages/agent/src/turn.ts',
    'packages/agent/src/activity.ts',
    'packages/agent/src/request.ts',
    'packages/agent/src/tools/hooks.ts',
    'packages/agent/src/tools/plan.ts',
    'packages/agent/src/tools/write-plan.ts',
    'packages/agent/src/verdict.ts',
    'packages/agent/src/workspace.ts',
  ],

  // The vitest runner resolves the project's own vite.config.ts by default, whose
  // include is the whole suite; this points it at the unit tests alone.
  vitest: { configFile: 'vitest.mutation.config.ts' },

  // `repos/` is the vendored Effect checkout, 53M of source this repo never runs;
  // copying it into the sandbox would dwarf the code under test.
  //
  // The root `tsconfig.json` is left out for a different reason: Stryker rewrites
  // the tsconfig it is pointed at through the TypeScript API, and the `typescript`
  // installed here is 7.x, which no longer exposes `parseConfigFileTextToJson` —
  // the rewrite throws before it starts. That file is a solution file for `tsc -b`
  // and holds no sources, nothing in the sandbox typechecks, and the per-package
  // tsconfigs (still copied) carry the `jsx` setting. So skipping it costs nothing.
  ignorePatterns: ['repos', 'coverage', '**/*.tsbuildinfo', '/tsconfig.json'],

  // Under pnpm, the workspace link `packages/tui/node_modules/agent` points at
  // `../../agent` — relative, so inside the sandbox it resolves to the sandbox's
  // own copy of `agent`, the one Stryker mutates. Unlike bun's hoisted layout, no
  // buildCommand re-linking is needed for a mutant to be exercised honestly.

  thresholds: { high: 80, low: 80, break: 80 },
  // `json` alongside the HTML one: the same report as data, which is what a survivor
  // is picked out of. The HTML page holds its copy inside a script tag, where reading
  // it means evaluating the page.
  reporters: ['html', 'json', 'clear-text', 'progress'],
  tempDirName: '.stryker-tmp',
}
