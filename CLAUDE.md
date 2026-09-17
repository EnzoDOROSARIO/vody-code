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

## Testing

`@effect/vitest` needs Vitest internals that Bun's runner does not provide, so it crashes under `bun test`. Effect tests here are plain `bun:test` cases that run the effect with `Effect.runPromise` and provide layers from `effect/testing` (`TestClock`, `TestConsole`) explicitly.

`bunfig.toml` scopes test discovery to `packages`, keeping the vendored suites under `repos/` out of `bun test`.
