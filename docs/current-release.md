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

Candidate Source and Published Latest may coincide after publication, but they are not required to. On the current line, Candidate Source and Published Latest are both aligned to `0.2.2-rc.3` / `v0.2.2-rc.3` (synced directly to pinned official kernel `@deepseek-ai/dsh@0.2.2-rc.3`; Complementary Edition Linux AppImage + official-runtime CycloneDX SBOM + Cosign bundles).

## Current line (2026-11-15)

| Fact | Value |
|---|---|
| Candidate official kernel | `@deepseek-ai/dsh@0.2.2-rc.3` |
| Candidate community product | `0.2.2-rc.3` |
| Candidate tag | `v0.2.2-rc.3` |
| GitHub Latest | [`v0.2.2-rc.3`](https://github.com/kamanager2012/dsh-community/releases/latest) |
| Published release evidence | GitHub release ID `445732060`; published `2026-11-15T08:39:25Z`; primary AppImage + Android APK asset IDs/digests pinned in `current-release.json` |
| Candidate Dual-Badge | `DeepSeek Harness Community v0.2.2-rc.3 [Official Core: @deepseek-ai/dsh@0.2.2-rc.3]` |
| Latest tested | `0.2.2-rc.3` — consolidated local acceptance PASS on commit `12e343a` and replay PASS on commit `69f647c` (runtime-lock attested by CI [run 43661345685](https://github.com/kamanager2012/dsh-community/actions/runs/43661345685)); published by `release` [run 43696033054](https://github.com/kamanager2012/dsh-community/actions/runs/43696033054) |
| Active Complementary endpoints (2 shipped + Android APK) | WSL/Linux Terminal, Linux AppImage, and signed Android `arm64-v8a` Remote Client APK (official `deepseek-harness` covers Win/macOS Desktop & Web) |
| Active unpublished endpoint | Android `apps/android` `[UNVERIFIED]` for physical `arm64-v8a` handset telemetry (CI `x86_64` emulator E2EE acceptance `PASS`, signed APK on Latest download page) |
| Retired from future releases | Windows Desktop (`DSH.Community.Setup.*.exe`), macOS Desktop (`dsh-community-*.dmg`) — last shipped in historical `v0.1.1-rc.2` |
| Official Web & Win/macOS Desktop | Upstream surfaces; not community endpoints |
| artifact-smoke | `[PASS]` on `v0.2.2-rc.3` ([run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193)): keyless Cosign verify (all 12 release assets) + Linux AppImage SHA256/extract + Android `arm64-v8a` APK SHA256/signature/purity + Linux Terminal smoke |
| Full user loop | `[PASS]` — exact-release `v0.2.2-rc.3` (`07fa09e1db70020a6ddae0c830e899de5a5fdd59`) WSL/Linux new→answer→resume→answer verified via [`user-loop-evidence.yml`](../.github/workflows/user-loop-evidence.yml) ([run 43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931); artifact `user-loop-evidence-v0.2.2-rc.3`) |
| Plugin `testedDsh` | `0.2.2-rc.3 (6/9 plugins; 3 legacy at 0.1.1-rc.2)` (compose: `plugin add` + `--dump-config` on `@deepseek-ai/dsh@0.2.2-rc.3` for 6 plugins; 3 legacy plugins remain at `0.1.1-rc.2`) |
| Historical tags | `v0.1.2`–`v0.1.6`, `v0.1.1-rc.2`, `v0.2.2-rc.2`, `v0.2.2-rc.2-community.1` are superseded by `v0.2.2-rc.3` |

Published `v0.2.2-rc.3` release-page primary binary assets (plus official-runtime CycloneDX SBOM, `.sha256`, and `.sigstore.json` bundles; Windows/macOS installers retired after historical `v0.1.1-rc.2`):

- `dsh-community-0.2.2-rc.3.AppImage`
- `dsh-community-0.2.2-rc.3-android-arm64-v8a.apk`

## Quick Download & Verification (`v0.2.2-rc.3`)

Download from [`releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest) (all 8 files carry SHA-256 sidecars and keyless Cosign bundles):

```sh
TAG=v0.2.2-rc.3
BASE="https://github.com/kamanager2012/dsh-community/releases/download/$TAG"

curl -fLO "$BASE/dsh-community-0.2.2-rc.3.AppImage" \
     -O "$BASE/dsh-community-0.2.2-rc.3.AppImage.sha256" \
     -O "$BASE/dsh-community-0.2.2-rc.3.AppImage.sigstore.json"

sha256sum -c dsh-community-0.2.2-rc.3.AppImage.sha256
cosign verify-blob \
  --bundle dsh-community-0.2.2-rc.3.AppImage.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity "https://github.com/kamanager2012/dsh-community/.github/workflows/release.yml@refs/tags/$TAG" \
  dsh-community-0.2.2-rc.3.AppImage

chmod +x dsh-community-0.2.2-rc.3.AppImage
./dsh-community-0.2.2-rc.3.AppImage
```

When the source pin changes, update Candidate Source fields in `current-release.json` in the same
commit as `pin.ts` / `package.json`. Do not move Published Latest, published assets,
plugin evidence, or user-loop evidence until those independent events actually happen. User-loop evidence
policy and the sanitized artifact contract are documented in
[`user-loop-evidence.md`](user-loop-evidence.md).
