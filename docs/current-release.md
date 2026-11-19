# Candidate and Published release facts

This file is the human index. The machine source of truth is
[`current-release.json`](current-release.json). Sister repositories should
**link here**, not copy version numbers.

Rules (1:1 kernel mirror, Dual-Badge, immutable tags) stay in
[version-policy.md](version-policy.md). Endpoint definitions stay in
[community-endpoints.md](community-endpoints.md).

## Candidate vs Published Latest

Source can move to a reviewed candidate before GitHub Latest moves. These are separate identities:

- `candidateTag`, `officialKernel.version`, `communityProduct.version`, workspace manifests, and the Dual-Badge describe the **Candidate Source** being built and reviewed.
- `communityProduct.githubLatestTag` describes **Published Latest**.
- `assets` / `publishedAssets` describe installers that actually exist for Published Latest; never synthesize filenames from an unpublished candidate.
- plugin `testedDsh` and user-loop evidence are evidence states, not aliases for Candidate Source. They move only after their own verification.

Candidate Source and Published Latest may coincide after publication, but they are not required to. On the current line, Candidate Source `0.2.2-rc.5` / `v0.2.2-rc.5` is now **published as GitHub Latest `v0.2.2-rc.5`** (release commit `0a8009d0462042764ad67e87208df791f1f6180b`, synced 1:1 to official kernel `@deepseek-ai/dsh@0.2.2-rc.5`; **12 uploaded files**: 3 primary artifacts — Linux AppImage, Android `arm64-v8a` APK, and official-runtime CycloneDX SBOM — plus 3 `.sha256` digests and 6 keyless Cosign `.sigstore.json` bundles, excluding GitHub auto-generated source archives).

## Current line (2026-11-19)

| Fact | Value |
|---|---|
| Candidate official kernel | `@deepseek-ai/dsh@0.2.2-rc.5` |
| Candidate community product | `0.2.2-rc.5` |
| Candidate tag | `v0.2.2-rc.5` |
| Candidate publication state | **[PUBLISHED]** — signed and published as GitHub Latest `v0.2.2-rc.5` ([`release` run 44453540672](https://github.com/kamanager2012/dsh-community/actions/runs/44453540672)) and verified by exact-tag `artifact-smoke` ([run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621)). |
| Candidate scope | Sync official `@deepseek-ai/dsh` kernel pin, workspace manifests, contracts, CI-attested Desktop runtime lock, Android R6 emulator acceptance, and Marketplace `0.2.2-rc.5` matrix onto `v0.2.2-rc.5`. |
| Last published Community Pre-release | [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1) (`releaseId=448012716`, published `2026-11-17T02:43:22Z`; superseded by Latest `v0.2.2-rc.5`): `release` [run 44004421253](https://github.com/kamanager2012/dsh-community/actions/runs/44004421253) + `artifact-smoke` [run 44005955539](https://github.com/kamanager2012/dsh-community/actions/runs/44005955539) `PASS` across 12 signed assets |
| GitHub Latest | [`v0.2.2-rc.5`](https://github.com/kamanager2012/dsh-community/releases/latest) |
| Published release evidence | GitHub release ID `450856726`; published `2026-11-19T03:51:33Z`; primary AppImage + Android APK asset IDs/digests pinned in `current-release.json` |
| Candidate Dual-Badge | `DeepSeek Harness Community v0.2.2-rc.5 [Official Core: @deepseek-ai/dsh@0.2.2-rc.5]` |
| Latest tested | `0.2.2-rc.5` — consolidated local acceptance PASS + Android R6 emulator acceptance PASS (`44441973511`) + published as GitHub Latest `v0.2.2-rc.5` (`release` [run 44453540672](https://github.com/kamanager2012/dsh-community/actions/runs/44453540672)) |
| Active Complementary endpoints (2 shipped + Android APK) | WSL/Linux Terminal, Linux AppImage, and signed Android `arm64-v8a` Remote Client APK (official `deepseek-harness` covers Win/macOS Desktop & Web) |
| Active unpublished endpoint | Android `apps/android` `[UNVERIFIED]` for physical `arm64-v8a` handset telemetry (CI `x86_64` emulator E2EE acceptance `PASS`, signed APK on Latest download page) |
| Retired from future releases | Windows Desktop (`DSH.Community.Setup.*.exe`), macOS Desktop (`dsh-community-*.dmg`) — last shipped in historical `v0.1.1-rc.2` |
| Official Web & Win/macOS Desktop | Upstream surfaces; not community endpoints |
| artifact-smoke | `[PASS]` on `v0.2.2-rc.5` ([run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621)): keyless Cosign verify (all 12 release assets) + Linux AppImage SHA256/extract + Android `arm64-v8a` APK SHA256/signature/purity + Linux Terminal smoke |
| Full user loop | `[PASS]` — exact-release `v0.2.2-rc.3` (`073826c38df4cf246e7ac90b27e0df98569a534d`) 3-way Session continuation roundtrip (`dsh-community` new→resume→official `dsh --profile headless --session-id`→Linux AppImage bundled `official-dsh.tar` headless→`dsh-community` resume) + packaged Linux AppImage Electron GUI (`AppRun` under `xvfb-run`) Session visibility, Runtime, & Marketplace checks + full 4-item lifecycle recovery (`missingKeyRefusal` exit 2 / 0 orphan sessions, `ensureOfficialHostExtracted` interrupted extraction recovery, `0.2.2-rc.2`→`0.2.2-rc.3` version upgrade & AppImage GUI runtime view, and TUI/Marketplace/Desktop GUI offline handling) verified via [`user-loop-evidence.yml`](../.github/workflows/user-loop-evidence.yml) ([run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796); artifact `user-loop-evidence-v0.2.2-rc.3`; prior [run 43713641736](https://github.com/kamanager2012/dsh-community/actions/runs/43713641736), [run 43709890408](https://github.com/kamanager2012/dsh-community/actions/runs/43709890408) & initial [run 43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931)) |
| Plugin `testedDsh` | `0.2.2-rc.5 (5/9 plugins; dsh-tui@0.20.1 at 0.2.2-rc.3; 3 legacy at 0.1.1-rc.2)` (compose: `plugin add` + `--dump-config` on `@deepseek-ai/dsh@0.2.2-rc.5` for 5 plugins; `@deepseek-harness-tui/dsh-tui@0.20.1` remains at `0.2.2-rc.3`; 3 legacy plugins remain at `0.1.1-rc.2`) |
| Historical tags | `v0.1.2`–`v0.1.6`, `v0.1.1-rc.2`, `v0.2.2-rc.2`, `v0.2.2-rc.2-community.1`, `v0.2.2-rc.3`, `v0.2.2-rc.3-community.1` are superseded by `v0.2.2-rc.5` |

Published `v0.2.2-rc.5` release-page primary binary assets (plus official-runtime CycloneDX SBOM, `.sha256`, and `.sigstore.json` bundles; Windows/macOS installers retired after historical `v0.1.1-rc.2`):

- `dsh-community-0.2.2-rc.5.AppImage`
- `dsh-community-0.2.2-rc.5-android-arm64-v8a.apk`

## Quick Download & Verification (`v0.2.2-rc.5`)

Download from [`releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest) (all 12 files carry SHA-256 sidecars and keyless Cosign bundles):

```sh
TAG=v0.2.2-rc.5
BASE="https://github.com/kamanager2012/dsh-community/releases/download/$TAG"

# Linux Desktop AppImage
curl -fLO "$BASE/dsh-community-0.2.2-rc.5.AppImage" \
     -O "$BASE/dsh-community-0.2.2-rc.5.AppImage.sha256" \
     -O "$BASE/dsh-community-0.2.2-rc.5.AppImage.sigstore.json"

sha256sum -c dsh-community-0.2.2-rc.5.AppImage.sha256
cosign verify-blob \
  --bundle dsh-community-0.2.2-rc.5.AppImage.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "https://github.com/kamanager2012/dsh-community/.github/workflows/release.yml@refs/tags/$TAG" \
  dsh-community-0.2.2-rc.5.AppImage

chmod +x dsh-community-0.2.2-rc.5.AppImage
./dsh-community-0.2.2-rc.5.AppImage

# Android Remote Client APK (arm64-v8a)
curl -fLO "$BASE/dsh-community-0.2.2-rc.5-android-arm64-v8a.apk" \
     -O "$BASE/dsh-community-0.2.2-rc.5-android-arm64-v8a.apk.sha256" \
     -O "$BASE/dsh-community-0.2.2-rc.5-android-arm64-v8a.apk.sigstore.json"

sha256sum -c dsh-community-0.2.2-rc.5-android-arm64-v8a.apk.sha256
cosign verify-blob \
  --bundle dsh-community-0.2.2-rc.5-android-arm64-v8a.apk.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "https://github.com/kamanager2012/dsh-community/.github/workflows/release.yml@refs/tags/$TAG" \
  dsh-community-0.2.2-rc.5-android-arm64-v8a.apk
```

When the source pin changes, update Candidate Source fields in `current-release.json` in the same
commit as `pin.ts` / `package.json`. Do not move Published Latest, published assets,
plugin evidence, or user-loop evidence until those independent events actually happen. User-loop evidence
policy and the sanitized artifact contract are documented in
[`user-loop-evidence.md`](user-loop-evidence.md).
