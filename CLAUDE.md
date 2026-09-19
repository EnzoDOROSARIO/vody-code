# vody-code

## Vendored reference sources

`repos/` holds upstream source vendored with `git subtree` — read-only reference material, pinned to the version this repo actually installs.

| Path | Upstream | Pinned at |
| --- | --- | --- |
| `repos/effect` | [Effect-TS/effect](https://github.com/Effect-TS/effect) | `effect@4.0.0-rc.115` |

Read it before reaching for an Effect API, and trust it over remembered APIs or web results: v4 is still an RC and moves. Three entry points, in the order they usually pay off:

- `repos/effect/LLMS.md` — Effect's own guidance for writing Effect code.
- `repos/effect/ai-docs/src/` — runnable worked examples, one directory per topic.
- `repos/effect/packages/effect/src/` — the implementation, when the above leave a signature ambiguous.

`repos/effect/.agents/AGENTS.md` is guidance for contributing to the Effect monorepo itself, so it does not apply here.

Application code imports from the installed `effect` package. Paths under `repos/` stay out of `import` statements and out of edits; the way to change one is to re-pull it:

```sh
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<version> --squash
```

Keep the pin above and the `effect` version in `packages/*/package.json` in step, so the vendored source is the source that runs.

## Linting and formatting

`bun run check` gates a change: Oxlint, then oxfmt, then `tsc`. `.oxlintrc.json` and `.oxfmtrc.json` hold the rules.

Oxlint runs with `--disable-nested-config` because nested discovery otherwise loads `repos/effect/.oxlintrc.json`, whose JS plugin this repo does not install. `ignorePatterns` alone does not prevent that: it filters files, not config discovery.

`.oxlint/anti-slop/` is a vendored Oxlint plugin that rejects low-evidence TypeScript — `unknown` parameters, assertion chains, runtime `typeof`, module mocking — plus Effect rules for tagged values and service constructors. Its rules are TypeScript, which Oxlint loads natively under Bun.

Treat it like `repos/`: read-only upstream code, excluded from lint, format, and typecheck. `.oxlint/anti-slop/UPSTREAM.md` records where the copy came from, how it already diverges, and how to check an edit to it. Install and update it with the `install-anti-slop` skill, and record any further local change there, or the next update silently drops it.

## Effect diagnostics

[`@effect/tsgo`](https://github.com/Effect-TS/tsgo) patches the TypeScript and Oxlint binaries in `node_modules` with the Effect language service. The patch does not survive a reinstall, so the `prepare` script re-applies it on every `bun install`.

Effect diagnostics reach you as Oxlint `effecttsgo/*` rules, from the `recommended` preset in `.oxlintrc.json`. They need `options.typeAware`, so leave it on. The language service plugin in `tsconfig.base.json` carries `diagnostics: false` on purpose: it would otherwise report the same findings a second time, through `tsc` and the editor.

That three-way patch demands exact versions — `@effect/tsgo@0.45.0` supports `typescript@7.0.2` and `oxlint@1.81`–`1.82`. So Oxlint is held at `1.82.0` rather than latest, with `@oxlint/plugins` matched to it. `effect-tsgo patch` refuses to run on an unsupported combination; check its support matrix before bumping any of the three.

## Typechecking

`tsconfig.json` is a solution file: it holds no sources, only references to the packages. `bun run typecheck` is `tsc -b`, which walks them. A new package needs a reference entry, or nothing typechecks it.

## Imports

Each package maps `#*` to its own `./src/*` through the `imports` field in its `package.json`, so an import that would climb out of its directory names its target from the package root instead: `#workspace.ts`, `#tools/index.ts`, `#__test__/testing.ts`. A sibling stays relative — `./errors.ts` reads better than `#tools/errors.ts` and is no harder to follow.

The leading `#` is the whole of the prefix. `"#/*": "./src/*"` looks tidier and cannot be used: the resolution algorithm rejects any specifier that is exactly `#` or starts with `#/`, so Bun fails it with `Cannot find module '#/…'`. `moduleResolution: "bundler"` in `tsconfig.base.json` is what makes the field visible to `tsc` as well as to Bun.

`imports` belongs to the package that declares it, so `#tools/index.ts` inside `tui` would mean `tui`'s own `src/tools`, not `agent`'s. Reach for another package by its name, as `tui` already does with `agent`.

Keeping siblings relative also keeps a lint rule working: `anti-slop-effect/no-service-constructor-imports` only inspects specifiers beginning `./` or `../`, so a `#` import slips past it. The constructors it guards live beside their callers, where the relative form still applies.

## Git hooks

Lefthook runs the `bun run check` gates on `pre-commit`, from `lefthook.yml`: lint, then format, then typecheck, stopping at the first failure. All three cover the whole repo rather than staged paths, since `tsc -b` is project-wide anyway. The format job is `format:check`, not `format` — a hook that rewrote files would leave the staged snapshot and the working tree disagreeing, so it reports and you run `bun run format`.

`lefthook install` writes `.git/hooks`, which is not tracked, so the `prepare` script re-runs it alongside the `effect-tsgo` patch on every `bun install`. `LEFTHOOK=0 git commit` skips the hook for a commit that is deliberately not green.

## TUI rendering

`packages/tui` renders with Ink, so its sources are `.tsx`. Nothing imports `React`: the automatic JSX runtime resolves `react/jsx-runtime` on its own, which is why `react/react-in-jsx-scope` is off in `.oxlintrc.json`.

`main` mounts the app through `Effect.acquireRelease`, so the enclosing scope unmounts Ink on success, failure and interruption — and `BunRuntime.runMain` turns Ctrl+C into that interruption. A mount outside that scope can exit with the cursor still hidden.

The root `tui` script goes through `--cwd`, not `--filter`. `bun run --filter` captures child output so it can prefix each line, which leaves `stdout.isTTY` false; Ink then picks non-interactive mode and writes only the final frame at unmount. A mounted TUI never unmounts, so the screen just stays blank. `--filter` is still right for scripts that only print, such as `test` and `typecheck`.

## Testing

`@effect/vitest` needs Vitest internals that Bun's runner does not provide, so it crashes under `bun test`. Effect tests here are plain `bun:test` cases that run the effect with `Effect.runPromise` and provide layers from `effect/testing` (`TestClock`, `TestConsole`) explicitly.

`bunfig.toml` scopes test discovery to `packages`, keeping the vendored suites under `repos/` out of `bun test`.

Tests live in a `__test__/` beside the code they cover, one per directory: `src/tools/__test__/` for the tools, `src/__test__/` for what sits at the root of a package. Scaffolding goes in the `__test__/` of whatever it serves — `tools/__test__/harness.ts` builds the temporary workspace and runs a single tool, while `src/__test__/testing.ts` composes the layers for both. Only `*.test.ts` is a test to Bun, so a helper sits there without being run.

`.oxlintrc.json` relaxes `effecttsgo/async-function` for `*.test.ts` alone, so a helper in a `__test__/` is held to the same rules as the source.

Ink views are tested with Ink's own `renderToString`, which renders to a string with no terminal and no timers. `ink-testing-library` is a separate, older package that pins React 18 — reach for `renderToString` instead.
