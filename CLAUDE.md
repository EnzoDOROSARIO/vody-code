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

## Testing

`@effect/vitest` needs Vitest internals that Bun's runner does not provide, so it crashes under `bun test`. Effect tests here are plain `bun:test` cases that run the effect with `Effect.runPromise` and provide layers from `effect/testing` (`TestClock`, `TestConsole`) explicitly.

`bunfig.toml` scopes test discovery to `packages`, keeping the vendored suites under `repos/` out of `bun test`.
