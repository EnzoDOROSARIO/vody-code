import { defineConfig } from 'tsdown'

// The TUI runs through node from the bundle: `bin` points at dist/cli.js, and
// `start` builds then runs it. `agent` is a workspace dependency whose exports
// are its TypeScript source — it is bundled in rather than left external, since
// node cannot import a `.ts` file at runtime. Everything else (effect, ink,
// react…) stays external, resolved from node_modules.
export default defineConfig({
  entry: ['src/cli.ts'],
  format: 'esm',
  platform: 'node',
  noExternal: ['agent'],
  outExtensions: () => ({ js: '.js' }),
})
