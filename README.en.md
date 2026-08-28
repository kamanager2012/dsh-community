# DSH Community

**One Harness. Five Community Endpoints.**

Official DeepSeek Harness is the kernel. This repo is based on that kernel:
one runtime, one `~/.dsh` session store, one official plugin chain. The
five community endpoints (**WSL/Linux terminal, Windows Desktop, macOS Desktop,
Linux AppImage, and Android**) are launchers, not a second Harness. Official Web
is the kernel's own UI — not a surface we ship — but it lives in the same world.

A conversation you start in official Web is the same conversation you resume in
`dsh-community` and then open again in Desktop.

[简体中文](README.md) | **English**

[![CI](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml)

| Channel | Download |
|---|---|
| **Current** | [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest) (`v0.1.1-rc.2`) |
| **Historical / Pre-release** | older independent numbers on [Releases](https://github.com/kamanager2012/dsh-community/releases) |

Current Latest, official kernel, five endpoints, asset names, and evidence labels
are in [current-release](docs/current-release.md) /
[`current-release.json`](docs/current-release.json). Rules:
[version policy](docs/version-policy.md).

The current release is **v0.1.1-rc.2**: root, Desktop, TUI, and every workspace
package share the number, 1:1 with official core `@deepseek-ai/dsh@0.1.1-rc.2`
(contract surface identical to rc.1 — 135 config rows, zero drift). Release
assets carry keyless cosign signatures (`.sigstore.json`); see
[release docs](docs/release.md#artifact-signing-keyless) for verification.

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
| Run the official Runtime directly | [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) |
| Download the community product | [Latest `v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest) — cosign signature verification: [release docs](docs/release.md#artifact-signing-keyless) |
| Use the WSL/Linux Terminal / TUI | `pnpm tui` or `dsh-community` after a source install |
| Use the Windows Desktop shell | [Latest `v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest) Setup.exe, or `pnpm desktop` |
| Use the macOS Desktop shell | [Latest `v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest) dmg, or `pnpm desktop` |
| Read operational guidance | [DeepSeek Harness Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/) |
| Verified community plugins | Desktop marketplace page, in-repo `pnpm marketplace`, and [`packages/marketplace/catalog.json`](packages/marketplace/catalog.json) — not an awesome list |

Only this repository is the download entry. Handbook is the other live repo. Suite, the standalone marketplace, the standalone plugins registry, and Edition are archived.

## Current release status

Community version is one workspace-wide identity: **0.1.1-rc.2**, 1:1 with
official core `@deepseek-ai/dsh@0.1.1-rc.2`. GitHub Latest is that same tag.
Earlier independent numbers `v0.1.2`–`v0.1.6` are historical only.
The Linux AppImage is community endpoint 4; the primary Linux CLI path remains WSL/Linux
Terminal. Official Web is an upstream companion, not a Community endpoint. Android is
endpoint 5 and stays `[UNVERIFIED]`. The Android prototype lives in the archived Labs repo.

## From source

Requirements: Node.js 22.15+, pnpm, and a configured `DEEPSEEK_API_KEY`.
Since official 0.1.0-rc.8, session JSONL uses `node:zlib` zstd APIs added in 22.15 (current pin: contracts/compatibility/latest-tested.json).
Sessions continue to use the official `~/.dsh` data source.

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
export DEEPSEEK_API_KEY=...
pnpm start
pnpm new
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

## Repository map

| Repository | Role | User-facing status |
|---|---|---|
| [`dsh-community`](https://github.com/kamanager2012/dsh-community) | Canonical Product | **唯一正式下载入口 / only official community download** |
| [`deepseek-harness-suite`](https://github.com/kamanager2012/deepseek-harness-suite) | Archived Labs | Frozen; do not install |
| [`deepseek-harness-handbook`](https://github.com/kamanager2012/deepseek-harness-handbook) | Knowledge / Evidence | Documentation and operational evidence |
| [`dsh-community-plugins`](https://github.com/kamanager2012/dsh-community-plugins) | Archived | Redirect to this repo's marketplace package |
| This repo `packages/marketplace` | Discovery / install CLI + catalog | `pnpm marketplace`; `catalog.json` lives in this package; install still goes through official `dsh plugin add` |
| [`dsh-marketplace`](https://github.com/kamanager2012/dsh-marketplace) | Archived | Redirect only |
| [`dsh-community-edition`](https://github.com/kamanager2012/dsh-community-edition) | Archived | Do not download from here |

## Layout and further reading

```text
contracts/              Official CLI and package surface snapshots
packages/dsh-bridge     Runtime process and lifecycle boundary
packages/marketplace    Plugin discovery CLI + catalog.json
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

## Security

See [SECURITY.md](SECURITY.md) for the Desktop shell's Electron hardening
(contextIsolation, default-deny permissions, allow-listed navigation), how to
verify a release's cosign keyless signature, the `~/.dsh` session-sharing
boundary, and how to report a security issue privately.

## License

MIT. Runtime and third-party notices are documented in [NOTICE](NOTICE) and the
official package metadata.
