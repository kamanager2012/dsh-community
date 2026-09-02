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

Candidate Source and Published Latest may coincide after publication, but they are not required to. On the current line Candidate Source and latest-tested are alpha.4 while Published Latest remains rc.2.

## Current line (2026-09-02)

| Fact | Value |
|---|---|
| Candidate official kernel | `@deepseek-ai/dsh@0.1.2-alpha.4` |
| Candidate community product | `0.1.2-alpha.4` |
| Candidate tag | `v0.1.2-alpha.4` |
| GitHub Latest | [`v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest) |
| Published release evidence | GitHub release ID `374950921`; published `2026-08-22T14:25:10Z`; primary installer asset IDs/digests pinned in `current-release.json` |
| Candidate Dual-Badge | `DeepSeek Harness Community v0.1.2-alpha.4 [Official Core: @deepseek-ai/dsh@0.1.2-alpha.4]` |
| Latest tested | `0.1.2-alpha.4` — promoted-tree consolidated acceptance PASS ([run 33577261413](https://github.com/kamanager2012/dsh-community/actions/runs/33577261413)); compatibility evidence only, not publication |
| Shipped Community endpoints | WSL/Linux Terminal, Windows Desktop, macOS Desktop, Linux AppImage |
| Active unpublished endpoint | Android `apps/android` `[UNVERIFIED]`, not on the Latest download page |
| Official Web | Kernel UI, not a community endpoint |
| artifact-smoke | `[PARTIAL]` on `v0.1.1-rc.2` ([run 32579569995](https://github.com/kamanager2012/dsh-community/actions/runs/32579569995)): checksum + cosign bundle verify (12 assets) + Windows/macOS first-ready + Linux TUI; full user loop still separate |
| Full user loop | `[UNVERIFIED]` — manual exact-release WSL/Linux new→answer→resume→answer gate now lives in [`user-loop-evidence.yml`](../.github/workflows/user-loop-evidence.yml); no successful release run is recorded yet, so status stays unchanged |
| Plugin `testedDsh` | `0.1.1-rc.2` (compose: `plugin add` + `--dump-config`; restart/user-loop still `[UNVERIFIED]`) |
| Historical tags | `v0.1.2`–`v0.1.6` are not the current download |

Release-page filenames (GitHub may show Windows spaces as dots):

- `dsh-community-0.1.1-rc.2.AppImage`
- `dsh-community-0.1.1-rc.2.dmg`
- `DSH.Community.Setup.0.1.1-rc.2.exe`

When the source pin changes, update Candidate Source fields in `current-release.json` in the same
commit as `pin.ts` / `package.json`. Do not move Published Latest, published assets,
plugin evidence, or user-loop evidence until those independent events actually happen. User-loop evidence
policy and the sanitized artifact contract are documented in
[`user-loop-evidence.md`](user-loop-evidence.md).
