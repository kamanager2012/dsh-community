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
| Candidate community product | `0.2.2-rc.5` | **Unpublished source candidate (`v0.2.2-rc.5`); no signed assets exist for this tag yet** |
| Last signed Community Pre-release | [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1) | Published 2026-11-17, passed exact-tag artifact-smoke; separate from `0.2.2-rc.5` source candidate |
| Published Latest | `v0.2.2-rc.3` | GitHub Latest; canonical user download entry |
| Historical tags | `v0.1.2`–`v0.1.6`, `v0.1.1-rc.2`, `v0.2.2-rc.2`, `v0.2.2-rc.2-community.1` | Superseded by `v0.2.2-rc.3` |

Desktop and TUI show the Dual-Badge identity (current Candidate Source / Pre-release):

```text
DeepSeek Harness Community v0.2.2-rc.5 [Official Core: @deepseek-ai/dsh@0.2.2-rc.5]
```

## User choice

The canonical download entry is
[`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest).
Normal users download [`v0.2.2-rc.3`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3).

Published `v0.2.2-rc.3` (release commit `073826c38df4cf246e7ac90b27e0df98569a534d`) uploads **12 release assets total (3 primary files + 3 `.sha256` digests + 6 keyless Cosign `.sigstore.json` bundles**, excluding GitHub's auto-generated source archives; under the Complementary Edition policy, it ships Linux AppImage + signed Android `arm64-v8a` Remote Client APK + official-runtime CycloneDX SBOM, while Windows `.exe` and macOS `.dmg` installers were retired after historical `v0.1.1-rc.2` in favor of upstream `deepseek-ai/deepseek-harness`):

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
| Release assets & signing | `[REAL]` | `v0.2.2-rc.3` (`releaseId=445732060`) and Pre-release [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1) (`releaseId=448012716`, `release` [Run 44004421253](https://github.com/kamanager2012/dsh-community/actions/runs/44004421253)) each published 12 assets with SHA-256 and keyless cosign bundles |
| `artifact-smoke` | `[REAL]` | Both `v0.2.2-rc.3` ([Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193)) and Candidate Pre-release `v0.2.2-rc.3-community.1` ([Run 44005955539](https://github.com/kamanager2012/dsh-community/actions/runs/44005955539)) passed `resolve`, `linux-appimage`, `android-apk`, `linux-terminal`, and `verify-signatures` across all 12 assets |
| Full user loop | `[PARTIAL]` | [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) passed `.github/workflows/user-loop-evidence.yml` 3-way `dsh-community` TUI ↔ official `dsh --profile headless` ↔ Linux AppImage bundled runtime (`official-dsh.tar`) Session continuation roundtrip, packaged AppImage Electron GUI (`AppRun`) Session visibility/Runtime/Marketplace checks, plus all 4 lifecycle recovery checks (prior runs [43713641736](https://github.com/kamanager2012/dsh-community/actions/runs/43713641736), [43709890408](https://github.com/kamanager2012/dsh-community/actions/runs/43709890408), [43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931)); interactive packaged GUI / Official Web turn-submission continuation and physical Android handset loops remain pending |

```text
tag
  → release-identity + runtime-sbom + build-linux + build-android
  → cosign keyless sign
  → publish 12 signed assets to GitHub Release
```

## Latest vs current Pre-release

`v0.2.2-rc.3` (commit `073826c`) remains Published Latest. Post-`rc.3` hardening and fixes (`scripts/install-linux.sh`, headless Chromium E2EE acceptance, fail-closed `observe` Git diff secret redaction, and Codex/ACP crash recovery) were tagged and published on `2026-11-17` as signed GitHub Pre-release [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1) (`release` [Run 44004421253](https://github.com/kamanager2012/dsh-community/actions/runs/44004421253), `artifact-smoke` [Run 44005955539](https://github.com/kamanager2012/dsh-community/actions/runs/44005955539)) without displacing `v0.2.2-rc.3`.

## Distribution Reality Gate

Exact-release-artifact evidence:

| Scenario | Status | Must prove |
|---|---|---|
| Linux AppImage + `dsh-community-0.2.2-rc.3.AppImage` | `[REAL]` | [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) verified SHA-256, extraction, headless launch checks, and keyless cosign signatures; [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) verified the bundled `official-dsh.tar` runtime resumes the shared Session while the packaged Electron GUI (`AppRun`) renders the shared Session ID and copy/resume command controls in `#sessions-table`, Runtime version status, and Marketplace offline cache fallback |
| WSL/Linux host + `dsh-community` / `pnpm tui` | `[REAL]` | Same run checked Linux TUI help, version, missing-key doctor, sessions, and no-TTY refusal; [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) verified 3-way `dsh-community` TUI ↔ official `dsh --profile headless` ↔ AppImage bundled runtime continuation plus AppImage Electron GUI Session list visibility |
| Session loop | `[PARTIAL]` | Three-way `dsh-community` TUI ↔ official `dsh --profile headless` ↔ Linux AppImage bundled runtime continuation sharing `~/.dsh`, plus shared Session visibility and copy/resume command controls inside packaged AppImage Electron GUI (`AppRun`), verified `[REAL]` in [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796); interactive Official Web / Win·macOS / Linux Desktop GUI turn continuation remains `[待复核]` |
| Plugin / restart | `[PARTIAL]` | 5/9 catalog plugins verified at `testedDsh` `0.2.2-rc.5` (`dsh plugin add` + `--dump-config`); `@deepseek-harness-tui/dsh-tui@0.20.1` remains at `0.2.2-rc.3`, and 3 legacy plugins remain at `0.1.1-rc.2` |
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
