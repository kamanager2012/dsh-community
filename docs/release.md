# Release order

Official `@deepseek-ai/dsh` is the **development foundation**. We build TUI and Desktop on the pinned official runtime. A newer official rc is an upgrade of that foundation (pin + contract extract), not a gate that pauses product work.

## Channels

| Channel | Tag | Notes |
|---|---|---|
| Stable | `vX.Y.Z` | Full release, marked Latest |
| Preview / Beta | `vX.Y.Z-preview` | Pre-release, AppImage + installers |

Windows / macOS artifacts are built by GitHub Actions (`release` workflow) — nobody needs to sit on those OSes.

## Cut a release

```sh
pnpm typecheck && pnpm test          # gate
node scripts/release.mjs v0.1.3-preview
```

The script checks a clean tree, a free tag, and a matching CHANGELOG section, then builds the AppImage locally as a sanity check and pushes the tag. The tag push starts the 3-OS `release` workflow:

1. **Linux** — typecheck + test + AppImage + sha256
2. **Windows** — NSIS installer (`DSH Community Setup x.y.z.exe`) + sha256. Portable zip is deferred until NSIS is reliably green.
3. **macOS** — dmg + sha256

The `publish` job collects all assets and creates the GitHub Release with the CHANGELOG section as notes. `-preview` tags are marked pre-release; plain tags become Latest.

## Artifact naming

```text
dsh-community-x.y.z.AppImage        Linux
DSH Community Setup x.y.z.exe       Windows installer
dsh-community-x.y.z-win-x64.zip     Windows portable
dsh-community-x.y.z.dmg             macOS (unsigned preview)
```

Every artifact ships a `<file>.sha256` sidecar.

## Manual checks after a release

```sh
curl -sL https://api.github.com/repos/kamanager2012/dsh-community/releases/latest | head
```

All "download Community" links in every repo point at:

```text
https://github.com/kamanager2012/dsh-community/releases/latest
```

## Distribution Reality Gate

Community version is **0.1.6**. Official Runtime pin is `@deepseek-ai/dsh@0.1.0-rc.6`.
Do not send users to `v0.1.3`, `v0.1.4`, or `v0.1.5`. Validate the exact Release
downloads separately from source or CI:

| Endpoint | Exact artifact / path | Required flow |
|---|---|---|
| Windows Desktop | `DSH.Community.Setup.0.1.6.exe` | clean VM → install → first launch → key → new/resume → plugin → restart |
| macOS Desktop | `dsh-community-0.1.6.dmg` | clean host → install → first launch → key → new/resume → plugin → restart |
| WSL/Linux Terminal | `dsh-community` / `pnpm tui` | clean WSL/Linux → key → new/resume → plugin → restart |
| Linux AppImage | `dsh-community-0.1.6.AppImage` | optional artifact smoke; not the primary Linux endpoint |

The gate must also cover uninstall/reinstall, upgrade, missing key, bad network, and
broken or interrupted Runtime extraction. Record Web ↔ Desktop ↔ TUI Session sharing
and the exact asset filename plus SHA256. `artifact-smoke` covers only install / first-ready / missing-key on the three
Community endpoints. It is not a full user loop. The gate remains `[UNVERIFIED]`
until a smoke run on the `v0.1.6` assets plus a real-machine loop pass. A green
unit test or a main-source smoke is not that evidence.

## Rules

- Never publish workspace packages to npm.
- Do not attach the 600MB `linux-unpacked` tree; attach the AppImage / installers.
- A failed platform job does not block the others; fix it in a follow-up patch release.
- Never move or retag a published `vX.Y.Z`. If the bits are wrong, cut `vX.Y.Z+1`. The publish job refuses to overwrite an existing GitHub Release.
