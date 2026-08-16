# DSH Community

**One Harness. Three Community Endpoints.**

The community **distribution** around official DeepSeek Harness: one runtime, one
`~/.dsh` session store, one official plugin chain. Our three community endpoints
are the **WSL/Linux terminal, Windows Desktop, and macOS Desktop**. Official Web
is the compatibility target — not a surface we ship — but it lives in the same
world. This is not the official client and not a second Harness.

A conversation you start in official Web is the same conversation you resume in
`dsh-community` and then open again in Desktop.

[简体中文](README.md) | **English**

[![CI](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml)

| Channel | Download |
|---|---|
| **Stable** | [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest) |
| **Preview** | newest Pre-release on [Releases](https://github.com/kamanager2012/dsh-community/releases) |

The number in `package.json` is the in-tree development version. The current formal download is **v0.1.4 Stable** and the latest Preview is **v0.1.3**. `v0.1.4` publishes a Linux AppImage, macOS dmg, and Windows NSIS installer, each with a matching `.sha256` file. `v0.1.2` is the historical baseline for the first three-platform Stable, not the current download.

## Stable baseline vs current main

`v0.1.4` is the current Stable release baseline. The root `package.json` and current
`main` code line are `0.1.4`. Current `main` may continue to receive post-release
documentation, diagnostics, and verification fixes; a main-source test is not proof
that the published installer contains the same fix.

The `v0.1.4` published assets are:

- `dsh-community-0.1.4.AppImage`
- `dsh-community-0.1.4.dmg`
- `DSH.Community.Setup.0.1.4.exe`

Each asset has a matching `.sha256` file. The latest exact-artifact smoke run passed
on macOS but failed on Windows, so the Release build is published while the user-reality
gate remains `[UNVERIFIED]`. Validate Stable with the exact assets downloaded from the
GitHub Release page, not a main build.

[Official Runtime](https://github.com/deepseek-ai/deepseek-harness)

## What this repository is

`dsh-community` is the only download entry. It is a distribution, not another
Desktop shell: thin adapters and contracts around published `@deepseek-ai/dsh`,
with official source ownership = 0 and no `patch-package` on official UI.

Official Runtime still owns the Agent loop, model execution, tool execution,
session persistence, and core lifecycle.

## Choose an entry

| Goal | Use |
|---|---|
| Run the official Runtime directly | [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) |
| Download the community product | [v0.1.4 Stable Release](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.4) — Windows/macOS Desktop and an optional Linux AppImage |
| Use the WSL/Linux Terminal / TUI | `pnpm tui` or `dsh-community` after a source install |
| Use the Windows Desktop shell | [`v0.1.4 Stable`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.4) NSIS installer, or `pnpm desktop` |
| Use the macOS Desktop shell | [`v0.1.4 Stable`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.4) dmg, or `pnpm desktop` |
| Read operational guidance | [DeepSeek Harness Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/) |
| Verified community plugins | [`dsh-marketplace`](https://github.com/kamanager2012/dsh-marketplace) and the [verification registry](https://github.com/kamanager2012/dsh-community-plugins) — not an awesome list |

Only this repository is the download entry. The other repos are roles (labs, docs,
verification, discovery, archive), not a finished ecosystem loop and not competing
products.

## Current release status

Keep these three layers separate. Do not hardcode them in the title.

| Layer | Where |
|---|---|
| Code line | root `package.json` |
| Preview | newest Pre-release on [Releases](https://github.com/kamanager2012/dsh-community/releases) |
| Stable | [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest) |

The current Stable is [`v0.1.4`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.4).
The latest Preview is [`v0.1.3`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.3).
The Linux AppImage remains an optional/secondary artifact; the primary Linux endpoint
is the WSL/Linux Terminal. Official Web is an upstream companion, not a Community
endpoint, and all four entry points use the official `~/.dsh` Session source.

## From source

Requirements: Node.js 22+, pnpm, and a configured `DEEPSEEK_API_KEY`.
Sessions continue to use the official `~/.dsh` data source.

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
export DEEPSEEK_API_KEY=...
pnpm start
pnpm new
pnpm desktop
pnpm doctor
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

## Repository map

| Repository | Role | User-facing status |
|---|---|---|
| [`dsh-community`](https://github.com/kamanager2012/dsh-community) | Canonical Product | **唯一正式下载入口 / only official community download** |
| [`deepseek-harness-suite`](https://github.com/kamanager2012/deepseek-harness-suite) | Community Labs | Experimental source; not a release channel |
| [`deepseek-harness-handbook`](https://github.com/kamanager2012/deepseek-harness-handbook) | Knowledge / Evidence | Documentation and operational evidence |
| [`dsh-community-plugins`](https://github.com/kamanager2012/dsh-community-plugins) | Verification registry | 9 third-party plugins install/compose-tested on rc.6; supply-chain CI continues to verify evidence |
| [`dsh-marketplace`](https://github.com/kamanager2012/dsh-marketplace) | Discovery / install UX | Stable maintenance, 11/11 tests green; install still goes through official `dsh plugin add` |
| [`dsh-community-edition`](https://github.com/kamanager2012/dsh-community-edition) | Archived | Do not download from here |

## Layout and further reading

```text
contracts/              Official CLI and package surface snapshots
packages/dsh-bridge     Runtime process and lifecycle boundary
packages/tui-adapter    Community TUI adapter and patch surface
packages/shared-types   Community-owned types, not an official event fork
apps/desktop            Official `dsh web` shell and session entry
apps/tui                Official profile / resume launcher
tests/upstream-contract Compatibility and upstream contract checks
```

Start with the [Getting Started guide](docs/getting-started.en.md). Then read [ARCHITECTURE.md](ARCHITECTURE.md), the [release guide](docs/release.md),
the [contract snapshots](contracts/README.md), and the [Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/)
before changing the runtime boundary.

## Evidence language

Use explicit status labels such as `[REAL]`, `[PARTIAL]`, `[LABS]`, `[PROBE]`,
`[FAIL-CLOSED]`, `[BLOCKED_BY_UPSTREAM]`, and `[UNVERIFIED]`. A green unit test,
a successful fallback, or a README statement is not by itself proof of a real
Runtime E2E.

## License

MIT. Runtime and third-party notices are documented in [NOTICE](NOTICE) and the
official package metadata.
