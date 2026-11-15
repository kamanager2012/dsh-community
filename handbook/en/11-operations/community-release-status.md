# Current Community release status

> Snapshot date: 2026-11-15. Machine-readable source of truth:
> [`dsh-community/docs/current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json).
> This page summarizes the operational status; it does not invent a second Latest or
> kernel pin and does not replace GitHub Releases, Actions runs, or user-loop checks.

## Version model

Community Candidate Source mirrors the official kernel 1:1 (adding `-community.N` only
for community-owned patches). **Candidate Source** and **Published Latest** are tracked
as independent states.

| Layer | Current value | Meaning |
|---|---|---|
| Official core pin | `@deepseek-ai/dsh@0.2.2-rc.3` | Official kernel |
| Candidate community product | `0.2.2-rc.3` | 1:1 mirror of the official kernel |
| Published Latest | `v0.2.2-rc.3` | GitHub Latest; only canonical user download |
| Historical tags | `v0.1.2`–`v0.1.6`, `v0.1.1-rc.2`, `v0.2.2-rc.2`, `v0.2.2-rc.2-community.1` | Superseded by `v0.2.2-rc.3` |

Desktop and TUI show the Dual-Badge identity:

```text
DeepSeek Harness Community v0.2.2-rc.3 [Official Core: @deepseek-ai/dsh@0.2.2-rc.3]
```

## User choice

The canonical download entry is
[`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest).
Normal users download [`v0.2.2-rc.3`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3).

Published `v0.2.2-rc.3` ships **12 signed files** under the Complementary Edition policy
(Linux AppImage + signed Android `arm64-v8a` Remote Client APK + official-runtime CycloneDX SBOM; Windows `.exe` and macOS `.dmg`
installers were retired after historical `v0.1.1-rc.2` in favor of upstream
`deepseek-ai/deepseek-harness`):

- `dsh-community-0.2.2-rc.3.AppImage` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`
- `dsh-community-0.2.2-rc.3-android-arm64-v8a.apk` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`
- `dsh-community-0.2.2-rc.3-official-runtime.cdx.json` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`

The three Complementary Community endpoints are **WSL/Linux Terminal** (shipped),
**Linux AppImage** (shipped), and **Android Remote Client** (signed `arm64-v8a` APK shipped in Published Latest; CI `x86_64` emulator E2EE verified, physical handset telemetry stays
`[UNVERIFIED]`). Official Web and Win/macOS Desktop belong
upstream and share `~/.dsh`, and are not Community endpoints.

## Complementary Edition Release Gate

Observed for this snapshot:

| Gate | Status | Evidence boundary |
|---|---|---|
| Normal `dsh-community` CI | `[REAL]` | `pnpm typecheck` and Vitest pass on `main`, but main CI does not prove installer readiness |
| Release assets & signing | `[REAL]` | `v0.2.2-rc.3` (`releaseId=445732060`) published 12 assets with SHA-256 and keyless cosign bundles |
| `artifact-smoke` | `[REAL]` | [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) passed `resolve`, `linux-appimage`, `android-apk`, `linux-terminal`, and `verify-signatures` across all 12 assets |
| Full user loop | `[PARTIAL]` | [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) passed `.github/workflows/user-loop-evidence.yml` 4-surface `dsh-community` TUI ↔ official `dsh --profile headless` ↔ Linux AppImage bundled runtime (`official-dsh.tar`) ↔ Linux AppImage Electron GUI (`AppRun`) Session roundtrip plus all 4 lifecycle recovery checks (prior runs [43713641736](https://github.com/kamanager2012/dsh-community/actions/runs/43713641736), [43709890408](https://github.com/kamanager2012/dsh-community/actions/runs/43709890408), [43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931)); Win/macOS packaged desktop and physical Android handset loops remain pending |

```text
tag
  → release-identity + runtime-sbom + build-linux + build-android
  → cosign keyless sign
  → publish 12 signed assets to GitHub Release
```

## Latest vs current main

`v0.2.2-rc.3` is current Published Latest. Later `main` commits may update docs,
remote control plane features, or smoke checks without altering the published binary assets.

## Distribution Reality Gate

Exact-release-artifact evidence:

| Scenario | Status | Must prove |
|---|---|---|
| Linux AppImage + `dsh-community-0.2.2-rc.3.AppImage` | `[REAL]` | [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) verified SHA-256, extraction, headless launch checks, and keyless cosign signatures; [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) verified both the bundled `official-dsh.tar` runtime and packaged Electron GUI (`AppRun`) resume and inspect the shared Session seamlessly |
| WSL/Linux host + `dsh-community` / `pnpm tui` | `[REAL]` | Same run checked Linux TUI help, version, missing-key doctor, sessions, and no-TTY refusal; [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) verified 4-surface `dsh-community` TUI ↔ official `dsh --profile headless` ↔ AppImage bundled runtime ↔ AppImage Electron GUI roundtrip |
| Session loop | `[PARTIAL]` | Four-way `dsh-community` TUI ↔ official `dsh --profile headless` ↔ Linux AppImage bundled runtime ↔ Linux AppImage Electron GUI (`AppRun`) handoff sharing `~/.dsh` verified `[REAL]` in [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796); Win·macOS Desktop installer handoff remains `[待复核]` |
| Plugin / restart | `[PARTIAL]` | 6/9 catalog plugins verified at `testedDsh` `0.2.2-rc.3` (`dsh plugin add` + `--dump-config`); 3 legacy plugins remain at `0.1.1-rc.2` |
| Lifecycle recovery | `[REAL]` | Missing-key clean refusal (exit 2 / 0 orphan sessions), `apps/desktop/src/host-extract.ts#ensureOfficialHostExtracted` interrupted Runtime extraction recovery, `0.2.2-rc.2 → 0.2.2-rc.3` version upgrade (in-place TUI profile upgrade, session preservation, and AppImage GUI runtime switch), and offline handling (TUI fail-closed plus Marketplace client/CLI and AppImage GUI cache fallback) all verified `[REAL]` in [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) |
| Android Remote Client | `[PARTIAL]` | Signed `dsh-community-0.2.2-rc.3-android-arm64-v8a.apk` shipped in Latest and verified in [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) plus CI `x86_64` emulator E2EE gate; physical `arm64-v8a` handset telemetry remains `[UNVERIFIED]` (`REAL_DEVICE_ACCEPTANCE_READY = false`) |

## Runtime version sources

```text
Official kernel: @deepseek-ai/dsh@0.2.2-rc.3
Community product / Published Latest: v0.2.2-rc.3
Historical independent numbers: v0.1.2–v0.1.6 (not a user download)
```

See:

- [`dsh-community` release workflow](https://github.com/kamanager2012/dsh-community/blob/main/.github/workflows/release.yml)
- [`dsh-community` changelog](https://github.com/kamanager2012/dsh-community/blob/main/CHANGELOG.md)
- [`dsh-community` contract snapshots](https://github.com/kamanager2012/dsh-community/tree/main/contracts)
- [`dsh-community` current-release.json](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json)
- In-repo [`archive/deepseek-harness-suite/`](https://github.com/kamanager2012/dsh-community/tree/main/archive/deepseek-harness-suite) (archived Labs; do not install)
