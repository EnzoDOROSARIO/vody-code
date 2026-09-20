// Bun's test runner has no Stryker plugin, so the command runner shells out to
// `bun test`. That runner reports a run rather than individual tests, so there is
// nothing to narrow a mutant down to the tests that touch it: `coverageAnalysis`
// stays off and every mutant costs a whole suite run (~2s).

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'command',
  commandRunner: { command: 'bun test' },
  coverageAnalysis: 'off',

  mutate: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx', '!packages/*/src/**/__test__/**'],

  // `repos/` is the vendored Effect checkout, 53M of source this repo never runs;
  // copying it into the sandbox would dwarf the code under test.
  //
  // The root `tsconfig.json` is left out for a different reason: Stryker rewrites
  // the tsconfig it is pointed at through the TypeScript API, and the `typescript`
  // installed here is 7.x, which no longer exposes `parseConfigFileTextToJson` —
  // the rewrite throws before it starts. That file is a solution file for `tsc -b`
  // and holds no sources, nothing in the sandbox typechecks, and Bun reads the
  // per-package tsconfigs (still copied) for `jsx`. So skipping it costs nothing.
  ignorePatterns: ['repos', 'coverage', '**/*.tsbuildinfo', '/tsconfig.json'],

  // Stryker symlinks the real `node_modules` into the sandbox, and the workspace
  // link it holds — `node_modules/agent` — points back at the original
  // `packages/agent`, not the copy Stryker mutates. A link nearer the importer wins
  // resolution, so `tui`'s tests exercise the mutated `agent` rather than the
  // pristine one, and mutants only its tests reach are reported honestly.
  buildCommand:
    'mkdir -p packages/tui/node_modules && ln -sfn ../../agent packages/tui/node_modules/agent',

  thresholds: { high: 80, low: 80, break: 80 },
  reporters: ['html', 'clear-text', 'progress'],
  tempDirName: '.stryker-tmp',
}
