// Vitest reads this file natively; it is also the file Vite+ (and its `vp`
// commands, `vp test` included) would pick up if the toolchain moves under
// `vp` later. Lint and format stay with the standalone oxlint/oxfmt pair —
// see .oxlintrc.json — so this file only configures the test runner.
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Pinned to this file's directory so a `vitest run --config …` invoked from
  // a package directory resolves the include patterns the same way the root
  // scripts do.
  root: fileURLToPath(new URL('.', import.meta.url)),
  // bunfig.toml scoped `bun test` to packages/ for the same reason: the vendored
  // Effect checkout under repos/ ships its own suites this repo never runs.
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/repos/**', '**/dist/**'],
    // The suites spawn git and bash against real workspaces under /tmp; bun's
    // default budget was generous, so keep the tests on a minute rather than
    // vitest's five seconds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
