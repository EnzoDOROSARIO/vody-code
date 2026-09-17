# vody-code

Bun workspace monorepo. Packages live in `packages/*`.

| Package | Description |
| --- | --- |
| [`tui`](packages/tui) | Terminal UI |

## Commands

```sh
bun install                    # install all workspace deps
bun run typecheck              # tsc --noEmit in every package
bun test                       # run all tests
bun run tui                    # run the tui package in watch mode
bun run --filter tui <script>  # run any script in one package
```

TypeScript settings are shared from `tsconfig.base.json`; each package extends it.
