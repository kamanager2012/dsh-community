# Contributing

## Ground rules

This is a reconstruction of community surfaces, not a fork. See [docs/reconstruction.md](docs/reconstruction.md).

1. Official `@deepseek-ai/dsh` is the only runtime. Do not copy official `packages/*` into this tree.
2. UI hangs on `session/event` and `ctx.agents`. Do not add an agent loop, tool pipeline, or model adapter here.
3. Prefer spawning the official CLI. In-process Cordis embed is out of scope.
4. Keep the TUI Ink UI where it is. KPI is fewer official Cordis row overrides, not a rewrite.
5. Desktop capabilities (tray, hide-on-close, host restart) are rewritten here. Do not paste third-party `apps/desktop` sources.
6. Do not add IPC or stdout parsers for agent/tool/session state. Snapshot official contracts; do not fork them.

## Checks before a PR

```sh
pnpm test
pnpm typecheck
```

Contract tests fail if:

- the pin in `packages/dsh-bridge` drifts from installed `@deepseek-ai/dsh`
- official `dsh --help` / `--version` no longer match the recorded surface
- this repo grows a vendored official core (`apps/cli`, `packages/session`, …)

## Adding a surface

A new surface (editor plugin, tray helper, etc.) should depend on `@dsh-community/dsh-bridge` or official plugin APIs, not on a forked monorepo.
