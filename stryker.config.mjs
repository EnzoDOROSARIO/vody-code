// The vitest runner gives Stryker real per-test coverage analysis: each mutant
// narrows to the tests that reach it, so a run costs mutant × affected tests
// rather than a whole suite per mutant. That replaces the command runner this
// config used under bun, which could only report a run at a time because bun's
// test runner has no Stryker plugin.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  coverageAnalysis: 'perTest',

  mutate: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx', '!packages/*/src/**/__test__/**'],

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
