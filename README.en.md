# DSH Community

**One Harness. Three Surfaces.**

The community **distribution** around official DeepSeek Harness: one runtime, one
`~/.dsh` session store, one official plugin chain. Official Web, Community Desktop,
and Community Terminal share that world. This is not the official client and not a
second Harness.

A conversation you start in official Web is the same conversation you resume in
`dsh-community` and then open again in Desktop.

[简体中文](README.md) | **English**

[![CI](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml)

| Channel | Download |
|---|---|
| **Stable** | [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest) |
| **Preview** | newest Pre-release on [Releases](https://github.com/kamanager2012/dsh-community/releases) |

The number in `package.json` is the in-tree development version. The current formal download is **v0.1.2 Stable**, whose GitHub Release includes the Linux AppImage, macOS dmg, and Windows NSIS installer. `v0.1.2-preview` is retained as an older Preview record; do not promote the v0.1.1 AppImage.

## Stable baseline vs current main

The `v0.1.2` tag is the fixed release baseline for the first three-platform Stable.
Current `main` is a post-release reliability line; a main-source test is not proof
that the published installer contains the same fix. At this snapshot, main includes:

- [`918f004`](https://github.com/kamanager2012/dsh-community/commit/918f004): Windows staging now hoists, dereferences, and flattens the complete dependency tree and writes a ready stamp so partial extraction is not accepted;
- [`e487cf0`](https://github.com/kamanager2012/dsh-community/commit/e487cf0): the first-launch loading window appears before the official Runtime is extracted in the background.

These are post-release main-line fixes. Unless a new Release explicitly includes them,
do not claim that the `v0.1.2` installer contains them. Validate Stable with the exact
assets downloaded from the GitHub Release page.

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
| Download the community product | [v0.1.2 Stable Release](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.2) — Linux AppImage, macOS dmg, and Windows NSIS |
| Use the Terminal / TUI | `pnpm tui` or `dsh-community` after a source install |
| Use the Desktop shell | [`v0.1.2 Stable`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.2) installer, or `pnpm desktop` |
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

The current Stable is [`v0.1.2`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.2).
It publishes the Linux AppImage, Windows NSIS installer, and macOS dmg, each with a
matching `.sha256` file. `v0.1.2-preview` is retained only for older-behavior
regression checks and is not the current download recommendation.

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
