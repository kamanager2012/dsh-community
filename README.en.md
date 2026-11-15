# DSH Community

[简体中文](README.md) | **English**

[![CI](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml)
[![Published Latest](https://img.shields.io/github/v/release/kamanager2012/dsh-community?include_prereleases&label=Published%20Latest)](https://github.com/kamanager2012/dsh-community/releases/latest)
[![Official Core](https://img.shields.io/badge/Official%20Core-%40deepseek--ai%2Fdsh-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **Start a task in official `dsh web` or official Win/macOS Desktop, resume it seamlessly in Linux Terminal, Linux AppImage, or on your Android phone — and steer DSH, Claude Code, Codex CLI, and OpenCode remotely over E2EE.**  
> Unvendored complementary community edition for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh`, Official Source Ownership = 0): 100% shared `~/.dsh` session truth, zero duplicate official surfaces, zero second agent loop.

## Highlights

- **Shared `~/.dsh` Across Official & Three Complementary Community Endpoints** — Official `deepseek-ai/deepseek-harness` owns the execution kernel, Web UI, and Windows/macOS Desktop (`win-x64`, `mac-arm64`, `mac-x64`). `dsh-community` delivers the **three complementary community endpoints** absent upstream: **WSL/Linux Terminal**, **Linux Desktop AppImage**, and **Android Remote Client APK** (`dsh-community-*-android-arm64-v8a.apk` shipped in [Published Latest](https://github.com/kamanager2012/dsh-community/releases/latest); CI `x86_64` emulator E2EE verified, physical `arm64-v8a` handset telemetry `[UNVERIFIED]`).
- **Multi-Agent E2EE Remote Control Plane** — Steer local **DSH, Claude Code, Codex CLI, and OpenCode ACP** sessions from the signed Android APK, browser PWA, or mobile screen (`dsh-community remote start --engines claude,codex,opencode --qr`) over Noise IK encryption, LAN mDNS, WebRTC P2P, or a self-hosted Blind Relay ([`deploy/relay/`](deploy/relay/)), with read-only scoped Git diff review.
- **Supply-Chain Verified Releases (12 Signed Assets) & Plugin Catalog** — Every release publishes the Linux `.AppImage`, Android `arm64-v8a` `.apk`, and official-runtime CycloneDX SBOM with SHA-256 digests and Keyless Cosign `.sigstore.json` bundles. [`packages/marketplace/catalog.json`](packages/marketplace/catalog.json) records real `testedDsh`, package integrity digests, and permission disclosures (installation remains on the official `dsh plugin add` chain).

---

## Why Choose DSH Community?

First, what the official project ships (from the upstream `deepseek-ai/deepseek-harness` source, checked 2026-11-15):

| Official offering | Details |
|---|---|
| Web UI | `npx @deepseek-ai/dsh web`; reachable from other machines' browsers through a reverse proxy plus a launch token |
| Windows / macOS Desktop | Electron shell (`win-x64`, `mac-arm64`, `mac-x64`); the official packaging docs state **Linux is not a supported Desktop release target** |
| `dsh` launcher | Boots profiles such as `web` / `headless` / `sdk` / `acp`; **ships no terminal UI of its own**, and upstream has no TUI package |
| Python SDK, ACP server | For programmatic use, not interactive UIs |

Several third-party projects already work on these gaps and around the official kernel. The comparison below uses only each project's own README and release page (stars as of 2026-11-15):

| Project | What it does | License | Stars |
|---|---|---|---|
| [`ccch1mneyyy/dsh-Go`](https://github.com/ccch1mneyyy/dsh-Go) | Flutter Android client: runs DSH on the phone in a built-in Ubuntu + Node environment (latest APK ~231 MB, plus ~1 GB runtime), or remote-controls a computer over SSH / DSHarness Remote; also phone control, desktop pets, native plugin UI | AGPL-3.0 | 23,280 |
| [`liguobao/ds-harness-remote`](https://github.com/liguobao/ds-harness-remote) | E2EE P2P remote access shipped as an official-style plugin (TURN / relay fallback); reaches DSH, Codex, Cursor, Antigravity, OpenCode, Claude Code and more over ACP; Android, Web, iOS (beta) clients | MIT | 2,941 |
| [`ccch1mneyyy/dsh-TUI`](https://github.com/ccch1mneyyy/dsh-TUI) | Third-party terminal UI plugin with a rich feature set | MIT | 7,735 |
| **DSH Community (this repo)** | Linux / WSL terminal UI, signed Linux AppImage, a runtime-free Android remote client, multi-agent E2EE remote control plane | MIT | 0 |

**Differences we can verify:**

- **Fills the official Linux gap**: a WSL/Linux terminal UI and a signed Linux `.AppImage`. None of the three projects above lists a Linux desktop installer in its README.
- **No changes to the official kernel**: nothing vendored, no `patch-package`; sessions are shared with the official `~/.dsh`. The terminal UI is our own `packages/tui`, and we never mount a third-party TUI.
- **Verifiable releases**: all 12 assets of each release carry SHA-256 and Keyless Cosign `.sigstore.json` bundles, plus an official-runtime CycloneDX SBOM; the APK is also v2/v3-signed. The latest dsh-Go release ships only the APK and `SHA256SUMS`.
- **Self-hostable and small**: the blind relay can be self-deployed ([`deploy/relay/`](deploy/relay/)), so no hosted service is required; the Android client is ~13 MB and embeds neither Node nor DSH.

**Weaknesses, stated just as plainly:**

- The project is new (0 stars); community size, documentation, and polish are far behind the three projects above.
- Android has passed only CI `x86_64` emulator E2EE acceptance; physical `arm64-v8a` handsets remain `[UNVERIFIED]`, and there is no iOS client.
- If you want to **run DSH on the phone itself** or use **phone control**, use dsh-Go; for **iOS, a hosted web client, or more agents (such as Cursor)**, look at DSHarness Remote; for a richer terminal UI, look at dsh-TUI. Our multi-agent plane covers only DSH, Claude Code, Codex CLI, and OpenCode.

---

## Quick Start

### 1. Download Signed Linux AppImage or Android APK

Grab the latest `.AppImage` (for Linux Desktop) or `-android-arm64-v8a.apk` (for Android 8.0+ `arm64-v8a` phones) from [Published Latest](https://github.com/kamanager2012/dsh-community/releases/latest), verify SHA-256 + Keyless Cosign signatures, and launch:

```sh
# See docs/current-release.json for exact filenames in Published Latest:
# https://github.com/kamanager2012/dsh-community/releases/latest

# Linux Desktop AppImage:
chmod +x dsh-community-*.AppImage
sha256sum -c dsh-community-*.AppImage.sha256
./dsh-community-*.AppImage

# Android Remote Client APK (verify checksum before installing via adb or on-device):
sha256sum -c dsh-community-*-android-arm64-v8a.apk.sha256
adb install dsh-community-*-android-arm64-v8a.apk
```

Verification guide: [`docs/release.md#artifact-signing-keyless`](docs/release.md#artifact-signing-keyless) · Current release ledger: [`docs/current-release.md`](docs/current-release.md)

### 2. Run from Source (WSL / Linux Terminal, Desktop, or Multi-Agent Remote)

Requirements: Node.js 24.9+ (official `@deepseek-ai/dsh@0.2.2-rc.3` declares `engines.node >=24.9.0`; this workspace requires at least 22.15 and CI passes on Node 22), pnpm, and either a configured `DEEPSEEK_API_KEY` (for DSH / hybrid mode) or local **Claude Code / Codex CLI / OpenCode** binaries on `PATH` (for standalone Multi-Agent Remote Control Plane mode).  
Since official `0.1.0-rc.8`, session JSONL uses `node:zlib` zstd APIs added in Node 22.15. Sessions continue to use the official `~/.dsh` data source.

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
export DEEPSEEK_API_KEY=...

# WSL/Linux TUI (resume latest ~/.dsh conversation or start a new one)
pnpm start
pnpm new
pnpm sessions            # list official session history
pnpm run doctor          # diagnostics (not bare `pnpm doctor` — that is pnpm's own command)

# Linux Desktop shell (with built-in Marketplace & Remote QR tab)
pnpm desktop

# Multi-Agent E2EE Remote Control Plane:
# 1) Build once, then serve the browser PWA + single-port blind gateway locally
pnpm build
pnpm start -- remote gateway --serve-web --port 8787 &
# 2) Start the Host (same-machine browser PWA via --web-url; add --host <LAN-IP> --mdns for LAN/Android discovery)
pnpm start -- remote start --engines claude,codex,opencode \
  --relay-url ws://127.0.0.1:8787/relay \
  --signaling-url ws://127.0.0.1:8787/signal \
  --web-url http://127.0.0.1:8787/app/ --qr
```

For cross-machine / mobile pairing over HTTPS TLS or Android `dsh-remote://pair` QR codes, reverse-proxy `remote gateway` per [`deploy/relay/README.md`](deploy/relay/README.md) and see [`docs/remote-host-client.md`](docs/remote-host-client.md).

Useful CLI subcommands (`dsh-community` or `dsh-community-tui`): `new`, `resume last`, `sessions`, `doctor`, `version`, `plugins` (read-only catalog view; install stays on official `dsh plugin add` / Desktop marketplace), `desktop`, and `remote`.

Package Linux Desktop locally (unsigned preview):

```sh
pnpm desktop:package
./apps/desktop/release/linux-unpacked/dsh-community

pnpm desktop:package -- --appimage
```

---

## Endpoints & Source/Release State

> **One Harness. Three complementary community endpoints — all published in Latest; Android physical `arm64-v8a` handset telemetry remains `[UNVERIFIED]`.**  
> Runtime, Session, plugin execution, Official Web, and Win/macOS Desktop belong to upstream `deepseek-ai/deepseek-harness`; historical Windows/macOS installers were retired after `v0.1.1-rc.2` (`--win` / `--mac` fail closed). Earlier independent numbers `v0.1.2`–`v0.1.6` are historical only.

| Surface | Owner | Entry |
|---|---|---|
| Official Web & Win/macOS Desktop | Upstream [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) | `npx @deepseek-ai/dsh web` / upstream desktop releases |
| WSL/Linux Terminal / TUI | **Complementary Endpoint 1 (Shipped)** | `dsh-community` / `pnpm start` / `pnpm tui` |
| Linux Desktop AppImage | **Complementary Endpoint 2 (Shipped)** | [Published Latest](https://github.com/kamanager2012/dsh-community/releases/latest) `.AppImage` |
| Android Remote Client | **Complementary Endpoint 3 (Shipped APK; physical `arm64-v8a` `[UNVERIFIED]`)** | [Published Latest](https://github.com/kamanager2012/dsh-community/releases/latest) `-android-arm64-v8a.apk` (`apps/android` + `packages/remote-adapter`, [architecture](docs/remote-host-client.md)) |
| Multi-Agent E2EE Remote Control Plane | Community Control Plane (`packages/remote-adapter`) | `dsh-community remote start --qr` / Desktop "远程" tab |
| Verified Community Plugins | Compatibility Catalog (Not Awesome List) | Desktop marketplace tab / `pnpm marketplace -- list` / [`catalog.json`](packages/marketplace/catalog.json) |
| Engineering & Ops Handbook | Documentation & AI Retrieval Catalog | [Online Handbook](https://kamanager2012.github.io/dsh-community/) · [`handbook/`](handbook/) |

**Candidate Source and Published Latest are independent states.**  
Source may advance to a newer reviewed upstream `@deepseek-ai/dsh` candidate while GitHub Latest, published installers, plugin `testedDsh`, and real User-Loop evidence remain on the last version that actually passed those gates. Do not infer workspace version from `releases/latest`, and never synthesize installer names from an unpublished candidate.

| State | Source of truth |
|---|---|
| **Published Latest** | [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest) — exact tag, asset names, release ID, and asset evidence live in [`docs/current-release.json`](docs/current-release.json) |
| **Candidate Source** | `candidateTag`, official-core pin (`packages/dsh-bridge/src/pin.ts`), workspace product version, and Dual-Badge live in [`docs/current-release.json`](docs/current-release.json) (`latest-tested.json` is compatibility evidence, not the pin source of truth) |
| **Historical / Pre-release** | [Releases](https://github.com/kamanager2012/dsh-community/releases) |

Read the locked endpoint definition in [Community endpoints](docs/community-endpoints.en.md) and start-to-finish onboarding in [Getting Started](docs/getting-started.en.md).

---

## Architectural Boundary & Success Criteria

`dsh-community` must **not vendor** official `packages/*` (`Official Source Ownership = 0`), must **not** `patch-package` official UI, must **not** fork the official event vocabulary, and must **not** maintain a second equivalent Session source of truth.

| Official Runtime owns | This repository owns |
|---|---|
| Agent loop and model execution | Complementary Desktop AppImage, Android Remote APK, and TUI distribution/UX |
| Tool execution and Runtime lifecycle | Lifecycle wrapping, diagnostics, and upstream compatibility contracts |
| Official Session persistence and event surface | Session selection, resume UX, and E2EE multi-agent adapters |
| Official CLI, profiles, and plugin surface | Keyless release packaging, plugin security metadata, and ecosystem links |

1. Official Source Ownership = 0 (zero vendored official code).
2. TUI patch-surface on official Cordis rows drops toward zero.
3. TUI/Desktop/Android do not implement Agent loop, Session persistence, or Tool execution.
4. One upstream rc bump requires zero business UI edits in principle.
5. WSL/Linux TUI, Linux AppImage, Android Remote Client, and official Web/Desktop share the same session truth (`~/.dsh`).
6. Upstream regressions break in contract CI before user release.

Currently: criteria 1, 3, and 5 hold by design; criterion 2 community overlay touches official rows without mounting third-party TUIs; criterion 4 is verified against upstream releases.

---

## Repository Map & Layout

[`dsh-community`](https://github.com/kamanager2012/dsh-community) is the **only canonical community download entry**. The former standalone repositories `dsh-marketplace`, `dsh-community-plugins`, `dsh-community-edition`, and `deepseek-harness-suite` were merged into this repository and deleted on 2026-09-13.

```text
contracts/              Official CLI and package surface snapshots + compatibility matrix
packages/dsh-bridge     Runtime process and lifecycle boundary
packages/marketplace    Plugin discovery CLI + audited catalog.json
packages/remote-adapter Multi-Agent E2EE control plane (DSH, Claude Code, Codex CLI, OpenCode ACP + scoped Git diff review) over Noise IK & LAN/WebRTC/Relay
packages/tui            Community terminal UI library (@dsh-community/tui-surface, Ink-based)
packages/tui-adapter    Community TUI adapter and patch surface
packages/shared-types   Community-owned types, not an official event fork
apps/desktop            Official `dsh web` Electron shell + session list + Marketplace/Remote UI
apps/remote-web         Browser PWA client for E2EE remote control
apps/android            Android Remote Client (shipped arm64-v8a APK; CI x86_64 emulator E2EE PASS, physical arm64-v8a [UNVERIFIED])
apps/tui                Official profile / resume launcher (`dsh-community`)
deploy/                 Self-hosted blind relay deployment configurations (`deploy/relay/`)
handbook/               Bilingual engineering handbook (`mkdocs`) & AI retrieval catalog
archive/                Frozen historical Labs (`archive/deepseek-harness-suite/`, excluded from build/CI)
tests/upstream-contract Compatibility, vendor=0, security, and release-gate contract checks
```

Further reading: [Getting Started](docs/getting-started.en.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [ECOSYSTEM.md](ECOSYSTEM.md) · [Release Guide](docs/release.md) · [Remote Host-Client](docs/remote-host-client.md) · [Contracts](contracts/README.md) · [Handbook](https://kamanager2012.github.io/dsh-community/).

## Evidence Language & Security

Use explicit status labels (`[REAL]`, `[PARTIAL]`, `[LABS]`, `[PROBE]`, `[FAIL-CLOSED]`, `[BLOCKED_BY_UPSTREAM]`, `[UNVERIFIED]`). A green unit test, successful fallback, or README statement is not proof of a real Runtime E2E.

See [SECURITY.md](SECURITY.md) for Desktop Electron hardening (`contextIsolation`, default-deny permissions, allow-listed navigation), keyless cosign signature verification, `~/.dsh` session-sharing boundaries, and private vulnerability reporting.

## Community & License

[Contributing](CONTRIBUTING.md) · [Governance](GOVERNANCE.md) · [Code of Conduct](CODE_OF_CONDUCT.md) · [Support](SUPPORT.md) · [Security](SECURITY.md)

MIT. Official runtime and third-party notices are documented in [NOTICE](NOTICE) and upstream `@deepseek-ai/dsh` package metadata.
