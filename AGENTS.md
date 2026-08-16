# Agent notes for dsh-community

**Read `ECOSYSTEM.md` first** — six-repo strategy, hard boundaries, and Reality Gate rules. This repo is the only canonical product; user downloads come only from `dsh-community/releases/latest`.

This is a community launcher/adapter workspace for official DeepSeek Harness.

- Runtime: published `@deepseek-ai/dsh` only. Pin is `packages/dsh-bridge/src/pin.ts`.
- Official apps today are cli+web. That is an architecture signal, not “official will never ship a TUI”.
- stdout/stderr are diagnostics. IPC is lifecycle only (pid/port/start/crash). No Desktop Runtime Protocol.
- Default: do not rewrite DSH_HOME. Sessions stay in official ~/.dsh so TUI/Web/Desktop share one log.
- Snapshot official surface under contracts/upstream. Do not maintain event-types.ts.
- Official `@deepseek-ai/dsh` is the development foundation. Third-party Desktop/TUI repos are references to beat, not remotes we patch.
- Terminal is apps/tui (`dsh-community`) + our own surface packages/tui (`@dsh-community/tui`) over official host seams. Never install or mount third-party TUI products; third-party TUIs are reference-only.
- Desktop KPI is Official Source Ownership = 0.
- Recommend latest tested from contracts/compatibility, not npm latest.
- Window state, catalog, and host.log live in Electron userData. Never write those under ~/.dsh.
- Publish only to https://github.com/kamanager2012/dsh-community. Do not merge this tree into another community DSH suite.
- Stability first: ship the minimal stable client. Capabilities plugins can carry (billing, auto-update, workspace/search panels) belong to the registry / plugin ecosystem, not to this repo.

Read `ARCHITECTURE.md` and `docs/upgrade.md` before changing layout.
