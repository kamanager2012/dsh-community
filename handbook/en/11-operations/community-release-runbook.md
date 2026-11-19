# Community release runbook

> Evidence status: `v0.2.2-rc.3` 12-asset exact-artifact smoke passed on real runners ([Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193)) and WSL/Linux user-loop evidence passed ([Run 43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931)); this page still separates launch/signature smoke, live user loop, and physical `arm64-v8a` handset telemetry, and README prose is not runtime evidence.

Links: [Current release status](community-release-status.md) · [Release checklist](../../content/11-operations/release-checklist.md) · [Ecosystem map](../00-overview/community-ecosystem.md) · [dsh-community Release](https://github.com/kamanager2012/dsh-community/releases/latest)

## Current fact boundary

- Published Latest is `v0.2.2-rc.3`, shipping **12 signed files**: `dsh-community-0.2.2-rc.3.AppImage`, `dsh-community-0.2.2-rc.3-android-arm64-v8a.apk`, `dsh-community-0.2.2-rc.3-official-runtime.cdx.json`, and their `.sha256` and `.sigstore.json` keyless cosign bundles.
- Official kernel is `@deepseek-ai/dsh@0.2.2-rc.5`, while Candidate Source is now `0.2.2-rc.5` (`v0.2.2-rc.5`, **unpublished**); the last signed Community Pre-release is [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1); `release` [Run 44004421253](https://github.com/kamanager2012/dsh-community/actions/runs/44004421253), `artifact-smoke` [Run 44005955539](https://github.com/kamanager2012/dsh-community/actions/runs/44005955539); does not displace `v0.2.2-rc.3` Latest). Historical independent numbers `v0.1.2`–`v0.1.6` and retired Win/macOS Desktop installers (`v0.1.1-rc.2` and earlier) are not current user downloads.
- Desktop/TUI must show: `DeepSeek Harness Community v0.2.2-rc.5 [Official Core: @deepseek-ai/dsh@0.2.2-rc.5]` (Candidate Source) / `v0.2.2-rc.3` (Published Latest).
- The three Complementary Community endpoints are WSL/Linux Terminal, Linux AppImage, and Android Remote Client (signed `arm64-v8a` APK shipped in Latest; CI `x86_64` emulator E2EE verified, physical handset telemetry `[UNVERIFIED]`). Official Web and Win/macOS Desktop belong upstream.
- [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) passed `resolve`, `linux-appimage`, `android-apk`, `linux-terminal`, and `verify-signatures` across all 12 assets, and [Run 43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931) passed the WSL/Linux live model user loop (`[REAL]`); physical `arm64-v8a` handset telemetry remains `[UNVERIFIED]`.
- If an installer ships with missing Runtime dependencies, halt promotion immediately and roll Latest back before cutting a fresh tag; never move or overwrite a published tag.

## 1. Freeze before release

Before invoking the release script, confirm:

- the working tree is clean;
- `CHANGELOG.md` has a section for the target version, and `package.json` aligns with `packages/dsh-bridge/src/pin.ts`;
- the target tag passes `node scripts/validate-release-tag.mjs <tag>` and `node scripts/validate-published-latest.mjs`;
- only `dsh-community` GitHub Releases are published (never npm-publish internal workspace packages);
- until live model verification runs against the published artifact, keep User-Loop status `[UNVERIFIED]`.

## 2. The real `release.mjs` flow

The script is `dsh-community/scripts/release.mjs`. Its fixed tag syntax is:

```text
node scripts/release.mjs <vX.Y.Z[-prerelease]>
```

Use `vX.Y.Z-community.N` only for a community-owned fix; standard upstream syncs mirror the kernel version directly (e.g. `v0.2.2-rc.3`). Never rerun an existing tag.

The script then:

1. checks tag syntax, `validate-published-latest.mjs`, a clean tree, an unused tag, the matching `CHANGELOG.md` section, and the `kamanager2012/dsh-community` remote;
2. runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, and `pnpm test`;
3. runs `pnpm desktop:package -- --appimage` as the local Linux AppImage sanity check;
4. creates and pushes the tag, starting the GitHub `release` workflow.

Stop on any failure. Do not use `--force`, move a tag, or overwrite a published Release.

## 3. Complementary Edition `release.yml` workflow

| Job | Artifact / check |
|---|---|
| `release-identity` | Validate immutable candidate release identity and current Published Latest facts |
| `runtime-sbom` | Generate official-runtime CycloneDX SBOM (`.cdx.json`) and `.sha256` sidecar |
| `build-linux` | `typecheck`, full `pnpm test`, Linux AppImage, `asar-purity` vendor=0 guard, `.sha256` |
| `build-android` | `verify-android-release-ready.mjs --allow-emulator-verified`, signed `arm64-v8a` APK, zero embedded Node/DSH check, `apksigner verify`, `.sha256` |
| `sign` | Keyless Sigstore OIDC signing (`cosign sign-blob --yes --bundle`) for every asset and `.sha256` |
| `publish` | Verify bundles, render changelog notes, and create GitHub Release (refuses to overwrite existing tag releases) |

Windows and macOS packaging jobs were retired under Complementary Edition; upstream `deepseek-ai/deepseek-harness` ships official Win/macOS Desktop releases.

## 4. SHA-256 & Keyless Cosign verification

Verify downloaded release assets from GitHub Releases directly:

```sh
sha256sum -c dsh-community-0.2.2-rc.3.AppImage.sha256
cosign verify-blob dsh-community-0.2.2-rc.3.AppImage \
  --bundle dsh-community-0.2.2-rc.3.AppImage.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/kamanager2012/dsh-community/\.github/workflows/release\.yml@refs/tags/v0\.2\.2-rc\.3$'
```

Matches prove artifact integrity and OIDC provenance `[REAL]`, not Runtime staging or interactive user-loop completion.

## 5. `artifact-smoke` gate

Trigger or inspect by exact tag:

```sh
gh workflow run artifact-smoke.yml --repo kamanager2012/dsh-community --field tag=v0.2.2-rc.3
gh run list --repo kamanager2012/dsh-community --workflow artifact-smoke.yml --limit 1
```

On `v0.2.2-rc.3`, [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) passed `resolve`, `linux-appimage`, `android-apk`, `linux-terminal`, and `verify-signatures` across all 12 assets, and `user-loop-evidence.yml` verified the 3-way `dsh-community` TUI ↔ official `dsh --profile headless` ↔ Linux AppImage bundled runtime (`official-dsh.tar`) Session continuation roundtrip, packaged Linux AppImage Electron GUI (`AppRun`) Session visibility/Runtime/Marketplace fallback checks, plus all 4 lifecycle recovery checks (missing-key refusal, `ensureOfficialHostExtracted()` interrupted Runtime extraction recovery, version upgrade, and offline cache fallback) in [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) (superseding [Run 43713641736](https://github.com/kamanager2012/dsh-community/actions/runs/43713641736) and [Run 43709890408](https://github.com/kamanager2012/dsh-community/actions/runs/43709890408)).

## 6. Latest promotion and rollback

### Promotion

After the release publishes all 12 signed assets and `artifact-smoke` succeeds, update `docs/current-release.json` and `docs/current-release.md` so Published Latest mirrors the live release without blurring Candidate Source vs Published Latest.

### Rollback

If an AppImage ships with missing official Runtime dependencies or a critical regression:

1. immediately stop promoting the broken release and roll Latest back;
2. preserve the Release, logs, hashes, and failure environment evidence;
3. never move, overwrite, or force-push the published tag;
4. fix and release a fresh tag (`-community.N` or next rc), re-running `release.yml` and `artifact-smoke`.

## 7. Handoff record

```text
Release tag:
Official core / Candidate Source:
Assets, SHA256 & Cosign bundles:
release.yml run:
artifact-smoke run:
User loop: UNVERIFIED / PARTIAL / REAL
Known limits:
Next review:
```
