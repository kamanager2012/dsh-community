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

Published `v0.2.2-rc.3` ships **8 signed files** under the Complementary Edition policy
(Linux AppImage + official-runtime CycloneDX SBOM only; Windows `.exe` and macOS `.dmg`
installers were retired after historical `v0.1.1-rc.2` in favor of upstream
`deepseek-ai/deepseek-harness`):

- `dsh-community-0.2.2-rc.3.AppImage` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`
- `dsh-community-0.2.2-rc.3-official-runtime.cdx.json` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`

The three Complementary Community endpoints are **WSL/Linux Terminal** (shipped),
**Linux AppImage** (shipped), and **Android Remote Client** (`apps/android`, stays
`[UNVERIFIED]`, excluded from Published Latest). Official Web and Win/macOS Desktop belong
upstream and share `~/.dsh`, and are not Community endpoints.

## Complementary Edition Release Gate

Observed for this snapshot; the full interactive user loop remains `[UNVERIFIED]` / `[待复核]`:

| Gate | Status | Evidence boundary |
|---|---|---|
| Normal `dsh-community` CI | `[REAL]` | `pnpm typecheck` and Vitest pass on `main`, but main CI does not prove installer readiness |
| Release assets & signing | `[REAL]` | `v0.2.2-rc.3` (`releaseId=445732060`) published 8 assets with SHA-256 and keyless cosign bundles |
| `artifact-smoke` | `[PARTIAL]` | [Run 43663270841](https://github.com/kamanager2012/dsh-community/actions/runs/43663270841) passed `resolve`, `linux-appimage`, `linux-terminal`, and `verify-signatures` |
| Full user loop | `[UNVERIFIED]` | `.github/workflows/user-loop-evidence.yml` exists, with no completed `v0.2.2-rc.3` live model run yet |

```text
tag
  → release-identity + runtime-sbom + build-linux
  → cosign keyless sign
  → publish 8 signed assets to GitHub Release
```

## Latest vs current main

`v0.2.2-rc.3` is current Published Latest. Later `main` commits may update docs,
remote control plane features, or smoke checks without altering the published binary assets.

## Distribution Reality Gate

Exact-release-artifact evidence only. First-launch / signature smoke is `[PARTIAL]`;
uncovered full-loop items remain `[UNVERIFIED]` / `[待复核]`:

| Scenario | Status | Must prove |
|---|---|---|
| Linux AppImage + `dsh-community-0.2.2-rc.3.AppImage` | `[PARTIAL]` | [Run 43663270841](https://github.com/kamanager2012/dsh-community/actions/runs/43663270841) verified SHA-256, extraction, headless launch checks, and keyless cosign signatures |
| WSL/Linux host + `dsh-community` / `pnpm tui` | `[PARTIAL]` | Same run checked Linux TUI help, version, missing-key doctor, sessions, and no-TTY refusal |
| Session loop | `[待复核]` | New, resume, Official Web / Win·macOS Desktop ↔ WSL/Linux TUI ↔ Linux AppImage sharing `~/.dsh` |
| Plugin / restart | `[待复核]` | 9 catalog plugins remain recorded at `testedDsh` `0.1.1-rc.2` (compose); `0.2.2-rc.3` & restart checks open |
| Lifecycle recovery | `[待复核]` | Upgrade, offline handling, missing key, interrupted Runtime extract |
| Android Remote Client | `[UNVERIFIED]` | Active source under `apps/android` + `packages/remote-adapter` (`REAL_DEVICE_ACCEPTANCE_READY = false`), excluded from Latest |

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
