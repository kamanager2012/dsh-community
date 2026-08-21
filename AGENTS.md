# Agent notes for dsh-community

**Read `ECOSYSTEM.md` first** — six-repo strategy, hard boundaries, and Reality Gate rules. This repo is the only canonical product; user downloads come only from `dsh-community/releases/latest`.

Official DeepSeek Harness is the kernel. This repo is based on published `@deepseek-ai/dsh`.

- Runtime: published `@deepseek-ai/dsh` only. Pin is `packages/dsh-bridge/src/pin.ts`.
- Community suite version 1:1-mirrors the official pin (`docs/version-policy.md`). Optional `-community.N` suffix for community-only patches. Dual-Badge via `formatCommunityIdentity()`.
- Product count is **five community endpoints** (`docs/community-endpoints.md`). Official Web is not one of them.
- Official apps today are cli+web. That is an architecture signal, not “official will never ship a TUI”.
- stdout/stderr are diagnostics. IPC is lifecycle only (pid/port/start/crash). No Desktop Runtime Protocol.
- Default: do not rewrite DSH_HOME. Sessions stay in official ~/.dsh so TUI/Web/Desktop share one log.
- Snapshot official surface under contracts/upstream. Do not maintain event-types.ts.
- Official `@deepseek-ai/dsh` is the development foundation. Third-party Desktop/TUI repos are references to beat, not remotes we patch.
- Terminal is apps/tui (`dsh-community`) + our own surface packages/tui (`@dsh-community/tui-surface`) over official host seams. Official tools stay enabled; execution and approval run on the official waterfall. Never install or mount third-party TUI products; third-party TUIs are reference-only.
- Terminal input arrives COOKED (the official CLI enables stdin raw mode first, then releases it): keyboard chunks come whole-line (`"y\r"`, `"/help\r"`). The surface normalizes chunks itself; never assume Ink raw-mode per-char delivery, and keep draft state in the store, not React state.
- Desktop KPI is Official Source Ownership = 0.
- Recommend latest tested from contracts/compatibility, not npm latest.
- Window state, catalog, and host.log live in Electron userData. Never write those under ~/.dsh.
- Publish only to https://github.com/kamanager2012/dsh-community. Do not merge this tree into another community DSH suite.
- Stability first: ship the minimal stable client. Capabilities plugins can carry (billing, auto-update, workspace/search panels) belong to the registry / plugin ecosystem, not to this repo.

Read `ARCHITECTURE.md` and `docs/upgrade.md` before changing layout.
