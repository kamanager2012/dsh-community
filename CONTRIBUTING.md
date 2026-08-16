# Contributing

## Ground rules

This is a reconstruction of community surfaces, not a fork. See [docs/reconstruction.md](docs/reconstruction.md).

Publish and open PRs only against **this** repository: [kamanager2012/dsh-community](https://github.com/kamanager2012/dsh-community). Do not merge this tree into another agent’s DSH suite.

1. Official `@deepseek-ai/dsh` is the development foundation and the only runtime. Do not copy official `packages/*` into this tree.
2. UI hangs on `session/event` and `ctx.agents`. Do not add an agent loop, tool pipeline, or model adapter here.
3. Prefer spawning the official CLI. In-process Cordis embed is out of scope.
4. Terminal is `apps/tui` (`dsh-community`). Boot official `dsh --profile headless`. Do not install or mount `@deepseek-harness-tui/dsh-tui`.
5. Desktop capabilities (tray, hide-on-close, host restart, official session list) are rewritten here. Do not paste third-party `apps/desktop` sources.
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
