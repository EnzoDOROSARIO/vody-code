# Vendored anti-slop Oxlint plugin

Installed on 2026-09-17 with `install-anti-slop`, from the skill's bundled assets at
`~/.claude/skills/install-anti-slop/assets/anti-slop`.

- **Upstream repository:** unknown. The skill bundle carries no repository URL or revision, and the
  skill directory is not a git checkout, so no upstream commit can be named here.
- **Snapshot identity:** SHA-256 of the sorted per-file digests of the bundled assets,
  `69fa217ad6262822167aeaa4b4cf9d10bddbba0bd9fcb7f83e1807f3707bdca3`, alongside the installing
  `SKILL.md`, `2cb88a6ec0c50d9456c695d3980a29e8b554bfab2a28cc8719ca7fa7a9e05ac5`. Recompute with:

  ```sh
  find . -type f | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256
  ```

  Run from the pristine asset directory; this copy no longer matches it (see deviations).

## Installed paths

- `.oxlint/anti-slop/index.ts` — generic plugin, registered as `anti-slop`.
- `.oxlint/anti-slop/effect/index.ts` — Effect plugin, registered as `anti-slop-effect`.
  Enabled because `packages/tui` depends on `effect` directly.
- `.oxlint/anti-slop/vendor/eslint-stylistic/` — MIT-licensed rule backing
  `require-readable-spacing`. Keep its `LICENSE` and `UPSTREAM.md` with every copy.

Both plugins are registered in `.oxlintrc.json` under `jsPlugins`, with every rule at `error`.
`.oxlint/anti-slop/**` is excluded from both `.oxlintrc.json` and `.oxfmtrc.json`: the plugin
is vendored code held to upstream's style, not to this repository's.

## Intentional deviations

- `rules/no-module-mocking.ts` also rejects Bun's module mocking. Upstream recognises `vi` from
  `vitest` and `jest` from `@jest/globals`; this copy additionally resolves `jest` and `mock`
  imported from `bun:test` and reports `mock.module(...)`. This repository's tests run on
  `bun:test`, so without it the rule is bypassed by the only mocking API these tests can reach.
  Re-apply it after any upstream update.

## Typechecking

No tsconfig covers this directory, so `bun run typecheck` skips it, exactly as it skips `repos/`.
The assets do not compile under `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`,
or `exactOptionalPropertyTypes`, which `tsconfig.base.json` enables for our own packages, and
relaxing those repo-wide to accommodate vendored code is the wrong trade.

Expect an editor to type these files against ES5 defaults and invent errors (`Cannot find name
'Set'`) that no compiler run reproduces. To check a local edit, point `tsc` at the directory with
upstream's strictness rather than adding a tsconfig here:

```sh
bunx tsc --ignoreConfig --noEmit --strict --target ESNext --module Preserve \
  --moduleResolution bundler --allowImportingTsExtensions \
  $(find .oxlint/anti-slop -name '*.ts')
```

It passes as of this install. `--ignoreConfig` is required: naming files on the command line while
a `tsconfig.json` sits at the root is an error without it.

## Updating

Re-run the `install-anti-slop` skill and follow its update procedure, which preserves the
deviations recorded above rather than overwriting them.
