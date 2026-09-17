# vody-code

Bun workspace monorepo. Packages live in `packages/*`.

| Package | Description |
| --- | --- |
| [`agent`](packages/agent) | Minimal agent loop over Effect AI |
| [`tui`](packages/tui) | Terminal UI |

## Commands

```sh
bun install                    # install all workspace deps
bun run typecheck              # tsc --noEmit in every package
bun test                       # run all tests
bun run agent                  # run the agent REPL in watch mode
bun run tui                    # run the tui package in watch mode
bun run --filter tui <script>  # run any script in one package (pipes output; not for the TUI)
```

TypeScript settings are shared from `tsconfig.base.json`; each package extends it.

## Vendored sources

`repos/effect` is the Effect source at `effect@4.0.0-rc.115`, vendored with `git subtree` as read-only
reference so agents can read the real implementation instead of guessing at a moving RC API. Update it with:

```sh
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<version> --squash
```

See [`CLAUDE.md`](CLAUDE.md) for the rules that apply to it.
