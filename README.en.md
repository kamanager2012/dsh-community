# DSH Community

**The canonical community distribution around the official DeepSeek Harness Runtime.**

[简体中文](README.md) | **English**

[![CI](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml)
[Latest release](https://github.com/kamanager2012/dsh-community/releases/latest) ·
[Official Runtime](https://github.com/deepseek-ai/deepseek-harness)

## What this repository is

`dsh-community` is the only canonical user-facing product in the DeepSeek Harness
Community ecosystem. It provides the Desktop and Terminal / TUI distribution layer,
diagnostics, compatibility checks, and release packaging around the published
`@deepseek-ai/dsh` Runtime.

It is not the official DeepSeek client and it is not a second Harness Runtime.
The official Runtime remains responsible for the Agent loop, model execution, tool
execution, official Session persistence, and core lifecycle.

## Choose an entry

| Goal | Use |
|---|---|
| Run the official Runtime directly | [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) |
| Download the community product | [Latest `dsh-community` release](https://github.com/kamanager2012/dsh-community/releases/latest) |
| Use the Terminal / TUI | `pnpm tui` or `dsh-community` after a source install |
| Use the Desktop shell | `pnpm desktop` or the platform asset in the latest release |
| Read operational guidance | [DeepSeek Harness Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/) |
| Browse community plugins | [`dsh-marketplace`](https://github.com/kamanager2012/dsh-marketplace) and the [compatibility registry](https://github.com/kamanager2012/dsh-community-plugins) |

Only this repository is the normal download entry. Suite, Edition, Marketplace,
Plugins, and the Handbook are supporting repositories, not competing products.

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
| [`dsh-community-plugins`](https://github.com/kamanager2012/dsh-community-plugins) | Compatibility Registry | Plugin metadata and verification status |
| [`dsh-marketplace`](https://github.com/kamanager2012/dsh-marketplace) | Discovery / Distribution UX | Browse and install front end |
| [`dsh-community-edition`](https://github.com/kamanager2012/dsh-community-edition) | Merge & Archive | Historical reference; no second product line |

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

Read [ARCHITECTURE.md](ARCHITECTURE.md), the [release guide](docs/release.md),
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
