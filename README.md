# DSH Community

> **Start a task in official `dsh web` or official Win/macOS Desktop, and resume it seamlessly in Linux Terminal or Linux AppImage.**  
> The unvendored complementary community edition for DeepSeek Harness — 100% shared `~/.dsh` session truth, zero duplicate official surfaces, zero second agent loop.

**Complementary community distribution, compatibility, and security-validation infrastructure for DeepSeek Harness.**

Official DeepSeek Harness remains the only execution kernel and owns Official Web plus Windows/macOS Desktop (`win-x64`, `mac-arm64`, `mac-x64`). This repository focuses exclusively on the **three Complementary Community endpoints** absent upstream — **WSL/Linux Terminal**, **Linux Desktop AppImage**, and **Android Remote Client** — plus exact upstream pin/contract tracking, a third-party plugin compatibility registry, and release/plugin security evidence.

WSL/Linux Terminal and Linux AppImage currently have Published Latest artifacts. The existing Android source is active in `apps/android` with a lightweight Remote Client target (`packages/remote-adapter`); it remains **[UNVERIFIED]** and is not yet part of Published Latest. (Historical `v0.1.1-rc.2` included Windows/macOS installers prior to upstream Desktop coverage and our Complementary Edition retirement.) Shipped endpoints share the official Runtime, official plugin chain, and the same `~/.dsh` Session source of truth by default.

A conversation you start in official Web or official Win/macOS Desktop is the same conversation you resume in `dsh-community` or Linux AppImage.

> **One Harness. Three complementary community endpoints. Two shipped today; Android active / UNVERIFIED.**
> Runtime, Session, plugin execution, Web, and Win/macOS Desktop remain owned by the official kernel; the
> community layer builds only the missing complementary endpoints, UX, compatibility, and verification.

The in-repo Compatibility Registry is not an awesome list: third-party entries
carry an actual `testedDsh` line, package integrity evidence, and structured
security metadata for network access, data egress, credentials, filesystem,
process execution, and persistence. Installation still uses the official
`dsh plugin add` chain.

**English** | [简体中文](README.zh-CN.md)

[![CI](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml)

| State | Source of truth |
|---|---|
| **Published Latest** | [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest); exact tag, asset names, release ID, and asset evidence live in [`current-release.json`](docs/current-release.json) |
| **Candidate Source** | `candidateTag`, official-core pin, workspace product version, and Dual-Badge live in [`current-release.json`](docs/current-release.json) |
| **Historical / Pre-release** | [Releases](https://github.com/kamanager2012/dsh-community/releases) |

**Candidate Source and Published Latest are independent states.** Source may move
to a newer reviewed upstream candidate while GitHub Latest, published installers,
plugin `testedDsh`, and real User-Loop evidence remain on the last version that
actually passed those gates. Do not infer workspace version from
`releases/latest`, and never synthesize installer names from an unpublished
candidate.

Endpoint status, Candidate/Published identity, asset names, and evidence labels
are centralized in [current-release](docs/current-release.md) /
[`current-release.json`](docs/current-release.json). Published assets carry
keyless cosign signatures; see [release docs](docs/release.md#artifact-signing-keyless).

[Official Runtime](https://github.com/deepseek-ai/deepseek-harness)

Read the locked endpoint definition in [Community endpoints](docs/community-endpoints.en.md).

## What this repository is

`dsh-community` is the only download entry. It is based on the official
kernel, not a second Harness: thin adapters and contracts around published
`@deepseek-ai/dsh`, official source ownership = 0, no `patch-package` on official
UI.

Official Runtime still owns the Agent loop, model execution, tool execution,
session persistence, official UI, and core lifecycle.

## Choose an entry

| Goal | Use |
|---|---|
| Run the official Runtime / Win & macOS Desktop | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) (`npx @deepseek-ai/dsh web`) |
| Download Linux AppImage (or inspect historical `v0.1.1-rc.2`) | [Published Latest](https://github.com/kamanager2012/dsh-community/releases/latest) — exact tag/file names: `docs/current-release.json`; cosign verification: [release docs](docs/release.md#artifact-signing-keyless) |
| Use the WSL/Linux Terminal / TUI | `pnpm tui` or `dsh-community` after a source install |
| Multi-Agent E2EE Remote Control Plane (DSH / Claude Code / Codex / OpenCode + Git review) | `dsh-community remote start [--engines claude,codex,opencode] --qr` or Linux Desktop "远程" tab (`packages/remote-adapter`; Android Remote endpoint remains `[UNVERIFIED]`) |
| Run or package Linux Desktop from source | `pnpm desktop` / `pnpm desktop:package -- --appimage` |
| Read operational guidance | [DeepSeek Harness Handbook](https://kamanager2012.github.io/dsh-community/) |
| Verified community plugins | Desktop marketplace page, in-repo `pnpm marketplace`, and [`packages/marketplace/catalog.json`](packages/marketplace/catalog.json) — not an awesome list |

Only this repository is the download entry. Suite, the standalone marketplace, the standalone plugins registry, and Edition were merged into this repository and their standalone repos were deleted on 2026-09-13; the handbook lives in [`handbook/`](handbook/) (formerly `deepseek-harness-handbook`) and the frozen Labs code in [`archive/`](archive/).

## Source and publication status

The workspace has one **Candidate Source** identity (community product + official
core pin + Dual-Badge), while GitHub exposes a separate **Published Latest**
identity backed by real release assets. They may be equal after a release, but
the repository does not depend on that equality. Exact current values live only
in `docs/current-release.json`.

Earlier independent numbers `v0.1.2`–`v0.1.6` are historical only, and Windows/macOS Desktop installers are retired after historical `v0.1.1-rc.2` (use official `deepseek-ai/deepseek-harness` for Windows/macOS Desktop). Linux Desktop AppImage is shipped Complementary endpoint 2 alongside primary WSL/Linux Terminal (endpoint 1). Official Web and Win/macOS Desktop are upstream surfaces, not Community endpoints. Android stays `[UNVERIFIED]`, is not shipped in Latest, and its first-party source lives in this repository under `apps/android`. Its target is now a lightweight Remote Client; the Host retains the official DSH runtime, repository/toolchain, credentials, and durable Session truth. See `docs/remote-host-client.md`.

## From source

Requirements: Node.js 22.15+, pnpm, and either a configured `DEEPSEEK_API_KEY` (for DSH / hybrid mode) or local **Claude Code / Codex CLI / OpenCode** binaries on `PATH` (for standalone Multi-Agent Remote Control Plane mode).
Since official 0.1.0-rc.8, session JSONL uses `node:zlib` zstd APIs added in 22.15. Candidate Source pin comes from `packages/dsh-bridge/src/pin.ts` / `current-release.json`; `latest-tested.json` is compatibility evidence, not the pin source of truth.
Sessions continue to use the official `~/.dsh` data source.

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
export DEEPSEEK_API_KEY=...
pnpm start
pnpm new
pnpm sessions           # list session history
pnpm plugins            # list installed plugins
pnpm desktop
pnpm run doctor         # not bare `pnpm doctor` — that is pnpm's own command
```

Useful commands exposed by the source distribution include `sessions`, `resume`,
`version`, and the read-only `plugins` catalog view. Plugin installation should
remain on the official `dsh plugin add` chain or the Desktop marketplace flow.

## Architectural boundary

| Official Runtime owns | This repository owns |
|---|---|
| Agent loop and model execution | Desktop / TUI distribution and UX |
| Tool execution and Runtime lifecycle | Lifecycle wrapping, diagnostics, and compatibility |
| Official Session persistence and event surface | Session selection, resume UX, and adapters |
| Official CLI, profiles, and plugin surface | Release packaging, safe integration, and ecosystem links |

The community layer must not vendor `packages/*`, fork the official event vocabulary,
or maintain a second equivalent Session source of truth. When an official capability
exists, use it; add community code only where a verified gap remains.

## Success criteria

1. Official Source Ownership = 0 (zero vendored official code).
2. TUI patch-surface on official Cordis rows drops toward zero.
3. TUI/Desktop do not implement Agent loop, Session persistence, or Tool execution.
4. One upstream rc bump requires zero business UI edits in principle.
5. WSL/Linux TUI, Linux AppImage, and official Web/Desktop share the same session truth.
6. Upstream regressions break in contract CI before user release.

Currently: 1, 3, and 5 hold by design; 2 community overlay touches official rows without mounting third-party TUIs. Criterion 4 is verified against upstream releases.

## Repository map

| Repository | Role | User-facing status |
|---|---|---|
| [`dsh-community`](https://github.com/kamanager2012/dsh-community) | Canonical Product | **唯一正式下载入口 / only official community download** |
| This repo [`archive/deepseek-harness-suite/`](archive/deepseek-harness-suite/) (formerly `deepseek-harness-suite`) | Archived Labs | Frozen; do not install |
| This repo `handbook/` | Knowledge / Evidence | Documentation and operational evidence (merged from `deepseek-harness-handbook`) |
| This repo `packages/marketplace` | Discovery / install CLI + catalog | `pnpm marketplace`; `catalog.json` lives in this package; install still goes through official `dsh plugin add` |

The former standalone repositories `dsh-marketplace`, `dsh-community-plugins`,
`dsh-community-edition`, and `deepseek-harness-suite` were merged into this
repository and deleted on 2026-09-13.

## Layout and further reading

```text
contracts/              Official CLI and package surface snapshots
packages/dsh-bridge     Runtime process and lifecycle boundary
packages/marketplace    Plugin discovery CLI + catalog.json
packages/remote-adapter Multi-Agent E2EE control plane (DSH, Claude Code, Codex CLI, OpenCode ACP + scoped Git diff review) over Noise IK & LAN/WebRTC/Relay
packages/tui            Community terminal UI library (@dsh-community/tui-surface, Ink-based)
packages/tui-adapter    Community TUI adapter and patch surface
packages/shared-types   Community-owned types, not an official event fork
apps/desktop            Official `dsh web` shell and session entry
apps/android            Android Remote Client ([LABS]/[UNVERIFIED]; migration target)
apps/tui                Official profile / resume launcher
tests/upstream-contract Compatibility and upstream contract checks
```

Start with the [Getting Started guide](docs/getting-started.en.md). Then read [ARCHITECTURE.md](ARCHITECTURE.md), the [release guide](docs/release.md),
the [contract snapshots](contracts/README.md), and the [Handbook](https://kamanager2012.github.io/dsh-community/)
before changing the runtime boundary.

## Evidence language

Use explicit status labels such as `[REAL]`, `[PARTIAL]`, `[LABS]`, `[PROBE]`,
`[FAIL-CLOSED]`, `[BLOCKED_BY_UPSTREAM]`, and `[UNVERIFIED]`. A green unit test,
a successful fallback, or a README statement is not by itself proof of a real
Runtime E2E.

## Security

See [SECURITY.md](SECURITY.md) for the Desktop shell's Electron hardening
(contextIsolation, default-deny permissions, allow-listed navigation), how to
verify a release's cosign keyless signature, the `~/.dsh` session-sharing
boundary, and how to report a security issue privately.

## Community

Project collaboration and maintenance entry points:
[Contributing](CONTRIBUTING.md) · [Governance](GOVERNANCE.md) ·
[Community Conduct](CODE_OF_CONDUCT.md) · [Support](SUPPORT.md) ·
[Security](SECURITY.md).

## License

MIT. Runtime and third-party notices are documented in [NOTICE](NOTICE) and the
official package metadata.
