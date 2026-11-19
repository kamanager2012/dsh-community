# Current Community release status

> Snapshot date: 2026-11-19. Machine-readable source of truth:
> [`dsh-community/docs/current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json).
> This page summarizes the operational status; it does not invent a second Latest or
> kernel pin and does not replace GitHub Releases, Actions runs, or user-loop checks.

## Version model

Community Candidate Source mirrors the official kernel 1:1 (adding `-community.N` only
for community-owned patches). **Candidate Source** and **Published Latest** are tracked
as independent states.

| Layer | Current value | Meaning |
|---|---|---|
| Official core pin | `@deepseek-ai/dsh@0.2.2-rc.5` | Official kernel |
| Candidate community product | `0.2.2-rc.5-community.1` | **Signed and published as GitHub Pre-release [`v0.2.2-rc.5-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.5-community.1) (12 assets verified via `artifact-smoke`, shipping the 18-plugin catalog & Starter Pack)** |
| Historical Community Pre-release | [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1) | Published 2026-11-17; superseded by `v0.2.2-rc.5` and `v0.2.2-rc.5-community.1` |
| Published Latest | `v0.2.2-rc.5` | GitHub Latest; canonical user download entry |
| Historical tags | `v0.1.2`–`v0.1.6`, `v0.1.1-rc.2`, `v0.2.2-rc.2`, `v0.2.2-rc.2-community.1`, `v0.2.2-rc.3`, `v0.2.2-rc.3-community.1` | Superseded by `v0.2.2-rc.5` |

Desktop and TUI show the Dual-Badge identity:

```text
DeepSeek Harness Community v0.2.2-rc.5-community.1 [Official Core: @deepseek-ai/dsh@0.2.2-rc.5]
```
(Published Latest `v0.2.2-rc.5` displays `DeepSeek Harness Community v0.2.2-rc.5 [Official Core: @deepseek-ai/dsh@0.2.2-rc.5]`.)

## User choice

The canonical download entry is
[`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest).
Normal users download [`v0.2.2-rc.5`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.5).

Published `v0.2.2-rc.5` (release commit `0a8009d0462042764ad67e87208df791f1f6180b`) uploads **12 release assets total (3 primary files + 3 `.sha256` digests + 6 keyless Cosign `.sigstore.json` bundles**, excluding GitHub's auto-generated source archives; under the Complementary Edition policy, it ships Linux AppImage + signed Android `arm64-v8a` Remote Client APK + official-runtime CycloneDX SBOM, while Windows `.exe` and macOS `.dmg` installers were retired after historical `v0.1.1-rc.2` in favor of upstream `deepseek-ai/deepseek-harness`):

- `dsh-community-0.2.2-rc.5.AppImage` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`
- `dsh-community-0.2.2-rc.5-android-arm64-v8a.apk` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`
- `dsh-community-0.2.2-rc.5-official-runtime.cdx.json` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`

The three Complementary Community endpoints are **WSL/Linux Terminal** (shipped),
**Linux AppImage** (shipped), and **Android Remote Client** (signed `arm64-v8a` APK shipped in Published Latest; CI `x86_64` emulator E2EE verified, physical handset telemetry stays
`[UNVERIFIED]`). Official Web and Win/macOS Desktop belong
upstream and share `~/.dsh`, and are not Community endpoints.

## Complementary Edition Release Gate

Observed for this snapshot:

| Gate | Status | Evidence boundary |
|---|---|---|
| Normal `dsh-community` CI | `[REAL]` | `pnpm typecheck` and Vitest pass on `main`, but main CI does not prove installer readiness |
| Release assets & signing | `[REAL]` | `v0.2.2-rc.5` Latest (`releaseId=450856726`, `release` [Run 44453540672](https://github.com/kamanager2012/dsh-community/actions/runs/44453540672)) and `v0.2.2-rc.5-community.1` Pre-release (`releaseId=451263403`, `release` [Run 44515930058](https://github.com/kamanager2012/dsh-community/actions/runs/44515930058)) each published 12 assets with SHA-256 and keyless cosign bundles (matching prior `v0.2.2-rc.3` and `v0.2.2-rc.3-community.1` standards) |
| `artifact-smoke` | `[REAL]` | `v0.2.2-rc.5` ([Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621)) and `v0.2.2-rc.5-community.1` ([Run 44516999116](https://github.com/kamanager2012/dsh-community/actions/runs/44516999116)) both passed `resolve`, `linux-appimage`, `android-apk`, `linux-terminal`, and `verify-signatures` across all 12 assets (following prior `v0.2.2-rc.3` [43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) and `v0.2.2-rc.3-community.1` [44005955539](https://github.com/kamanager2012/dsh-community/actions/runs/44005955539)) |
| Full user loop | `[PARTIAL]` | [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) passed `.github/workflows/user-loop-evidence.yml` 3-way session continuation, Electron GUI (`AppRun`) checks, and all 4 lifecycle recovery checks against `v0.2.2-rc.3`; a dedicated live-API user-loop run for `v0.2.2-rc.5` binaries and physical Android handset loops remain pending |

```text
tag
  → release-identity + runtime-sbom + build-linux + build-android
  → cosign keyless sign
  → publish 12 signed assets to GitHub Release
```

## Latest vs historical Pre-release

`v0.2.2-rc.5` (commit `0a8009d0462042764ad67e87208df791f1f6180b`) is now Published Latest, incorporating all fixes previously shipped in Pre-release `v0.2.2-rc.3-community.1` (`scripts/install-linux.sh`, headless Chromium E2EE acceptance, fail-closed `observe` Git diff redaction, Codex/ACP crash recovery), #182 mDNS/pairing fixes, and the `@deepseek-ai/dsh@0.2.2-rc.5` kernel sync.

## Distribution Reality Gate

Exact-release-artifact evidence:

| Scenario | Status | Must prove |
|---|---|---|
| Linux AppImage + `dsh-community-0.2.2-rc.5.AppImage` | `[REAL]` | [Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621) verified `0.2.2-rc.5` SHA-256, extraction, and keyless cosign signatures; prior `rc.3` [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) proved bundled `official-dsh.tar` and Electron GUI (`AppRun`) behavior |
| WSL/Linux host + `dsh-community` / `pnpm tui` | `[REAL]` | [Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621) checked `v0.2.2-rc.5` Linux TUI help, version, missing-key doctor, sessions, and no-TTY refusal; prior `rc.3` [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) verified 3-way session continuation |
| Session loop | `[PARTIAL]` | Verified `[REAL]` for `v0.2.2-rc.3` in [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796); interactive Official Web / Desktop GUI turn continuation remains `[待复核]` |
| Plugin / restart | `[PARTIAL]` | 15/18 catalog plugins verified at `testedDsh` `0.2.2-rc.5` (`dsh plugin add` + `--dump-config`, including 6 Starter Pack picks and `@deepseek-harness-tui/dsh-tui@0.20.2`); 3 legacy plugins remain at `0.1.1-rc.2` |
| Lifecycle recovery | `[REAL]` | Missing-key clean refusal, interrupted Runtime extraction recovery, version upgrade preservation, and offline handling all verified `[REAL]` in [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) |
| Android Remote Client | `[PARTIAL]` | Signed `dsh-community-0.2.2-rc.5-android-arm64-v8a.apk` shipped in Latest and verified in [Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621) plus `0.2.2-rc.5` CI `x86_64` KVM emulator E2EE gate ([Run 44441973511](https://github.com/kamanager2012/dsh-community/actions/runs/44441973511)); physical `arm64-v8a` handset telemetry remains `[UNVERIFIED]` (`REAL_DEVICE_ACCEPTANCE_READY = false`) |

## Runtime version sources

```text
Official kernel: @deepseek-ai/dsh@0.2.2-rc.5
Community product / Published Latest: v0.2.2-rc.5
Historical independent numbers: v0.1.2–v0.1.6 (not a user download)
```

See:

- [`dsh-community` release workflow](https://github.com/kamanager2012/dsh-community/blob/main/.github/workflows/release.yml)
- [`dsh-community` changelog](https://github.com/kamanager2012/dsh-community/blob/main/CHANGELOG.md)
- [`dsh-community` contract snapshots](https://github.com/kamanager2012/dsh-community/tree/main/contracts)
- [`dsh-community` current-release.json](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json)
- In-repo [`archive/deepseek-harness-suite/`](https://github.com/kamanager2012/dsh-community/tree/main/archive/deepseek-harness-suite) (archived Labs; do not install)

> **Latest Community Pre-release**: [`v0.2.2-rc.5-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.5-community.1) (on official `@deepseek-ai/dsh@0.2.2-rc.5`, shipping the curated 18-plugin catalog, Desktop Starter Pack, and `dsh-marketplace starter`) is signed and verified via `release.yml` ([Run 44515930058](https://github.com/kamanager2012/dsh-community/actions/runs/44515930058)) and `artifact-smoke` ([Run 44516999116](https://github.com/kamanager2012/dsh-community/actions/runs/44516999116)) across all 12 assets; Published Latest stays [`v0.2.2-rc.5`](https://github.com/kamanager2012/dsh-community/releases/latest).
