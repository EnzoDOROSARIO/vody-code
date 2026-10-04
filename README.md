```text
__     __         _          ____          _
\ \   / /__   __| |_   _   / ___|___   __| | ___
 \ \ / / _ \ / _` | | | | | |   / _ \ / _` |/ _ \
  \ V / (_) | (_| | |_| | | |__| (_) | (_| |  __/
   \_/ \___/ \__,_|\__, |  \____\___/ \__,_|\___|
                   |___/
```

PNPM workspace monorepo. Packages live in `packages/*`. Everything runs on Node.

| Package | Description |
| --- | --- |
| [`agent`](packages/agent) | Minimal agent loop over Effect AI |
| [`tui`](packages/tui) | Terminal UI |

## Commands

```sh
pnpm install                    # install all workspace deps
pnpm run typecheck              # tsc -b across the workspace
pnpm test                       # vitest run over every package
pnpm run tui                    # run the tui package in watch mode (tsx watch)
pnpm run start                  # build the tui bundle (tsdown) and run it on node
pnpm --filter tui <script>      # run any script in one package
```

TypeScript settings are shared from `tsconfig.base.json`; each package extends it.

## Vendored sources

`repos/effect` is the Effect source at `effect@4.0.0`, vendored with `git subtree` as read-only
reference so agents can consult the implementation behind the stable API. Update it with:

```sh
git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<version> --squash
```

See [`CLAUDE.md`](CLAUDE.md) for the rules that apply to it.
