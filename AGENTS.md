# vody-code

## Vendored reference sources

`repos/` holds upstream source vendored with `git subtree` — read-only reference material, pinned to the version this repo actually installs.

| Path | Upstream | Pinned at |
| --- | --- | --- |
| `repos/effect` | [Effect-TS/effect](https://github.com/Effect-TS/effect) | `effect@4.0.0` |

Read it before reaching for an Effect API, and trust it over remembered APIs or web results. Three entry points, in the order they usually pay off:

- `repos/effect/LLMS.md` — Effect's own guidance for writing Effect code.
- `repos/effect/ai-docs/src/` — runnable worked examples, one directory per topic.
- `repos/effect/packages/effect/src/` — the implementation, when the above leave a signature ambiguous.

`repos/effect/.agents/AGENTS.md` is guidance for contributing to the Effect monorepo itself, so it does not apply here.

Application code imports from the installed `effect` package. Paths under `repos/` stay out of `import` statements and out of edits; the way to change one is to re-pull it:

```sh
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<version> --squash
```

Keep the pin above and the Effect versions in `pnpm-workspace.yaml` in step, so the vendored source is the source that runs.

## Linting and formatting

`pnpm run check` gates a change: Oxlint, then oxfmt, then `tsc`. `.oxlintrc.json` and `.oxfmtrc.json` hold the rules.

Oxlint runs with `--disable-nested-config` because nested discovery otherwise loads `repos/effect/.oxlintrc.json`, whose JS plugin this repo does not install. `ignorePatterns` alone does not prevent that: it filters files, not config discovery.

`.oxlint/anti-slop/` is a vendored Oxlint plugin that rejects low-evidence TypeScript — `unknown` parameters, assertion chains, runtime `typeof`, module mocking — plus Effect rules for tagged values and service constructors. Its rules are TypeScript, which Oxlint loads natively.

Treat it like `repos/`: read-only upstream code, excluded from lint, format, and typecheck. `.oxlint/anti-slop/UPSTREAM.md` records where the copy came from, how it already diverges, and how to check an edit to it. Install and update it with the `install-anti-slop` skill, and record any further local change there, or the next update silently drops it.

## Effect diagnostics

[`@effect/tsgo`](https://github.com/Effect-TS/tsgo) patches the TypeScript and Oxlint binaries in `node_modules` with the Effect language service. The patch does not survive a reinstall, so the `prepare` script re-applies it on every `pnpm install`.

Effect diagnostics reach you as Oxlint `effecttsgo/*` rules, from the `recommended` preset in `.oxlintrc.json`. They need `options.typeAware`, so leave it on. The language service plugin in `tsconfig.base.json` carries `diagnostics: false` on purpose: it would otherwise report the same findings a second time, through `tsc` and the editor.

That three-way patch demands exact versions — `@effect/tsgo@0.45.0` supports `typescript@7.0.2` and `oxlint@1.81`–`1.82`. So Oxlint is held at `1.82.0` rather than latest, with `@oxlint/plugins` matched to it. `effect-tsgo patch` refuses to run on an unsupported combination; check its support matrix before bumping any of the three.

## Typechecking

`tsconfig.json` is a solution file: it holds no sources, only references to the packages. `pnpm run typecheck` is `tsc -b`, which walks them. A new package needs a reference entry, or nothing typechecks it.

## Imports

Each package maps `#*` to its own `./src/*` through the `imports` field in its `package.json`, so an import that would climb out of its directory names its target from the package root instead: `#workspace.ts`, `#tools/index.ts`, `#__test__/testing.ts`. A sibling stays relative — `./errors.ts` reads better than `#tools/errors.ts` and is no harder to follow.

The leading `#` is the whole of the prefix. `"#/*": "./src/*"` looks tidier and cannot be used: the resolution algorithm rejects any specifier that is exactly `#` or starts with `#/`, so node fails it with `Cannot find module '#/…'`. `moduleResolution: "bundler"` in `tsconfig.base.json` is what makes the field visible to `tsc` as well as to node.

`imports` belongs to the package that declares it, so `#tools/index.ts` inside `tui` would mean `tui`'s own `src/tools`, not `agent`'s. Reach for another package by its name, as `tui` already does with `agent`.

Keeping siblings relative also keeps a lint rule working: `anti-slop-effect/no-service-constructor-imports` only inspects specifiers beginning `./` or `../`, so a `#` import slips past it. The constructors it guards live beside their callers, where the relative form still applies.

## Git hooks

Lefthook runs the `pnpm run check` gates on `pre-commit`, from `lefthook.yml`: lint, then format, then typecheck, stopping at the first failure. All three cover the whole repo rather than staged paths, since `tsc -b` is project-wide anyway. The format job is `format:check`, not `format` — a hook that rewrote files would leave the staged snapshot and the working tree disagreeing, so it reports and you run `pnpm run format`.

`lefthook install` writes `.git/hooks`, which is not tracked, so the `prepare` script re-runs it alongside the `effect-tsgo` patch on every `pnpm install`. `LEFTHOOK=0 git commit` skips the hook for a commit that is deliberately not green.

## Toolchain

The package manager is pnpm (`pnpm-workspace.yaml` holds the workspace globs and the version catalog; `pnpm-lock.yaml` is committed). The runtime is node — every script runs under it, `@effect/platform-bun` is gone in favour of `@effect/platform-node` (`NodeServices.layer`, `NodeRuntime.runMain`), and the TUI ships as a bundle: `packages/tui` builds `src/cli.ts` to `dist/cli.js` with tsdown (`bin` points there, `pnpm run start` builds then runs it, `pnpm run tui` is `tsx watch` for development). The bundle pulls the workspace `agent` package's TypeScript source in, since node cannot import a `.ts` file; everything else stays external.

Vite+ is installed (`vite-plus`, the `vp` CLI) and `vite.config.ts` follows its shape, but its commands are not wired up here: `vp lint`/`vp fmt` would ride vite-plus's own bundled Oxlint, which the `@effect/tsgo` patch cannot reach (that patch needs oxlint 1.81–1.82; vite-plus pins 1.85), and `vp test` runs vite-plus's private vitest instance, which `@effect/vitest` cannot see without t3code's `patches/@effect__vitest` recipe — a patch that would also strand Stryker's vitest runner. The standalone oxlint/oxfmt pair plus plain vitest cover the same ground; follow t3code's patch recipe if the tradeoff is ever wanted.

One runner pitfall is worth keeping written down: `tsx watch` is unusable for this app — it restarts the process on every stdin keystroke, so a raw-mode Ink TUI reloads mid-sentence. Development runs through node's own watch mode with tsx as the loader instead: `node --import tsx --watch src/cli.ts` restarts on file changes only and leaves the TTY to the child.

## TUI rendering

`packages/tui` renders with Ink, so its sources are `.tsx`. Nothing imports `React`: the automatic JSX runtime resolves `react/jsx-runtime` on its own, which is why `react/react-in-jsx-scope` is off in `.oxlintrc.json`.

`main` mounts the app through `Effect.acquireRelease`, so the enclosing scope unmounts Ink on success, failure and interruption — and `NodeRuntime.runMain` turns Ctrl+C into that interruption. A mount outside that scope can exit with the cursor still hidden.

`pnpm --filter tui <script>` streams a single workspace's output untouched, so the TUI stays interactive through it. The capture pitfall bun's `--filter` had does not exist here.

## Testing

Tests run on Vitest: `pnpm test` is `vitest run`, with the runner configured in `vite.config.ts` — `test.include` is scoped to `packages/*/src/**`, which keeps the vendored suites under `repos/` out of the run the way `bunfig.toml` once scoped `bun test`. Vitest rides node, so `.tsx` test files and JSX sources transform through the same vite/oxc pipeline the bundle uses.

Effect tests are `@effect/vitest` cases. A body that runs a program is `it.live('name', () => Effect.gen(…))` — real services, real clock — and a body that is pure is a plain `it`. `it.effect` exists when a test wants the fake `TestClock`/`TestConsole` the package would otherwise merge in itself; these suites pin `TestClock` through their own `Layer.mergeAll` provides instead, so they stay on `it.live`. Imports come from `@effect/vitest`, never from `vitest` directly: the package re-exports the whole Vitest API and keeps one vitest instance in the graph — the overrides in `pnpm-workspace.yaml` pin `@effect/vitest`'s peer and one vite so every consumer (runner, `@effect/vitest`, Stryker's vitest runner) resolves to the same store entry. `import { it } from '@effect/vitest'` registering with a different vitest copy than the one running is the failure to avoid, and it is what those pins are for.

Tests live in a `__test__/` beside the code they cover, one per directory: `src/tools/__test__/` for the tools, `src/__test__/` for what sits at the root of a package. Scaffolding goes in the `__test__/` of whatever it serves — `tools/__test__/harness.ts` builds the temporary workspace and runs a single tool, while `src/__test__/testing.ts` composes the layers for both. Filesystem probes that sit outside effects (`write`, `readText`, `fileExists`, `rendered`) live in `testing.ts` over plain `node:fs/promises`, standing in for the `Bun.*` globals bun used to give tests. Only `*.test.ts` is a test to the runner, so a helper sits there without being run.

`.oxlintrc.json` relaxes `effecttsgo/async-function` for `*.test.ts` alone, so a helper in a `__test__/` is held to the same rules as the source.

Ink views are tested with Ink's own `renderToString`, which renders to a string with no terminal and no timers. `ink-testing-library` is a separate, older package that pins React 18 — reach for `renderToString` instead.

## Mutation testing

`pnpm run mutation` is `stryker run`, configured in `stryker.config.mjs`. It breaks at a mutation score of 80: below that the run exits non-zero. The reports land in `reports/mutation/` — `mutation.html` to read, `mutation.json` to pick survivors out of as data — and both `reports/` and the `.stryker-tmp/` sandbox are gitignored.

The run is a unit gate. The tests it executes come from `vitest.mutation.config.ts` — the tests that need no filesystem, no git, no child process, no network — and the `mutate` set is what those tests reach: the TUI's sources, and the loop's own logic, whose tests run it with the model scripted at the top seam and the tools answering from cans behind the seam's hooks. So a mutant is paid for in memory-only work and the whole run takes about half a minute. Code only the infra suites reach — the tools' own effects, the Gates over real disk, the session that reads the workspace's instructions — is not mutated by this run: its assurance is the suites that run it for real, and the way to put such code under mutation is to make its tests unit first, which grows the `mutate` set by the same stroke.

The runner is Stryker's own vitest plugin with `coverageAnalysis: 'perTest'`: a mutant pays only for the tests its coverage reaches, not for a whole suite — what the command runner this config replaced under bun could not do, because bun's runner has no Stryker plugin. The sandbox needs a couple of deliberate settings to work at all — each is commented at the option it guards in `stryker.config.mjs`, and that is the copy to keep correct.

It runs locally, not in CI: by hand, and in the review workflow's `Mutation` phase after `CRAP`, which holds the gate until every survivor in the files a change touched — where the run has mutants to begin with — is either killed or marked. Neither carries its own copy of the threshold — 80 lives in `thresholds.break` and nowhere else — so putting the run back in CI is a job that calls `pnpm run mutation` and nothing more.

Entry points are mutated like everything else: `tui/src/cli.ts` and most of `tui/src/index.tsx` mount the app and no unit test reaches them, so they are a standing drag on the total rather than a scoring exemption.

A mutant no test can tell apart is marked where it lives, with `// Stryker disable <mutator>: <reason>` — one mutator rather than `all`, so the reason and what it excuses stay the same size, and a reason that says why the code cannot observe the change. Anything else is a test that is missing.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in `EnzoDOROSARIO/vody-code`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
