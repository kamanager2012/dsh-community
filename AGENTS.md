# Agent notes for dsh-community

This is a community launcher/adapter workspace for official DeepSeek Harness.

- Runtime: published `@deepseek-ai/dsh` only. Pin is `packages/dsh-bridge/src/pin.ts`.
- Official apps today are cli+web. That is an architecture signal, not “official will never ship a TUI”.
- stdout/stderr are diagnostics. IPC is lifecycle only (pid/port/start/crash). No Desktop Runtime Protocol.
- Default: do not rewrite DSH_HOME. Sessions stay in official ~/.dsh so TUI/Web/Desktop share one log.
- Snapshot official surface under contracts/upstream. Do not maintain event-types.ts.
- Official `@deepseek-ai/dsh` is the development foundation. Third-party Desktop/TUI repos are references to beat, not remotes we patch.
- Our TUI product is apps/tui (`dsh-community-tui`). Mount reference Ink as a plugin; do not add it as a dsh.bundle.
- Desktop KPI is Official Source Ownership = 0.
- Recommend latest tested from contracts/compatibility, not npm latest.
- Window state, catalog, and host.log live in Electron userData. Never write those under ~/.dsh.

Read `ARCHITECTURE.md` and `docs/upgrade.md` before changing layout.
