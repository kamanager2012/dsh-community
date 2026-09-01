# Current release facts

This file is the human index. The machine source of truth is
[`current-release.json`](current-release.json). Sister repositories should
**link here**, not copy version numbers.

Rules (1:1 kernel mirror, Dual-Badge, immutable tags) stay in
[version-policy.md](version-policy.md). Endpoint definitions stay in
[community-endpoints.md](community-endpoints.md).

## Current line (2026-08-22)

| Fact | Value |
|---|---|
| Official kernel | `@deepseek-ai/dsh@0.1.1-rc.2` |
| Community product | `0.1.1-rc.2` |
| GitHub Latest | [`v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest) |
| Dual-Badge | `DeepSeek Harness Community v0.1.1-rc.2 [Official Core: @deepseek-ai/dsh@0.1.1-rc.2]` |
| Shipped Community endpoints | WSL/Linux Terminal, Windows Desktop, macOS Desktop, Linux AppImage |
| Experimental endpoint | Android Labs `[UNVERIFIED]`, not on the Latest download page |
| Official Web | Kernel UI, not a community endpoint |
| artifact-smoke | `[PARTIAL]` on `v0.1.1-rc.2` ([run 32579569995](https://github.com/kamanager2012/dsh-community/actions/runs/32579569995)): checksum + cosign bundle verify (12 assets) + Windows/macOS first-ready + Linux TUI; full user loop still separate |
| Full user loop | `[UNVERIFIED]` — manual exact-release WSL/Linux new→answer→resume→answer gate now lives in [`user-loop-evidence.yml`](../.github/workflows/user-loop-evidence.yml); no successful release run is recorded yet, so status stays unchanged |
| Plugin `testedDsh` | `0.1.1-rc.2` (compose: `plugin add` + `--dump-config`; restart/user-loop still `[UNVERIFIED]`) |
| Historical tags | `v0.1.2`–`v0.1.6` are not the current download |

Release-page filenames (GitHub may show Windows spaces as dots):

- `dsh-community-0.1.1-rc.2.AppImage`
- `dsh-community-0.1.1-rc.2.dmg`
- `DSH.Community.Setup.0.1.1-rc.2.exe`

When the pin or Latest tag changes, update `current-release.json` in the same
commit as `pin.ts` / `package.json`. CI checks they match. User-loop evidence
policy and the sanitized artifact contract are documented in
[`user-loop-evidence.md`](user-loop-evidence.md).
