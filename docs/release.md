# Release order

Official `@deepseek-ai/dsh` is the **development foundation**. We build TUI and Desktop on the pinned official runtime. A newer official rc is an upgrade of that foundation (pin + contract extract), not a gate that pauses product work.

Current official pin is `@deepseek-ai/dsh@0.1.0-rc.8` (`packages/dsh-bridge/src/pin.ts`). That is the official GitHub current release / npm `next`. npm `latest` is still `0.1.0-rc.7`; this repo does not follow npm latest.

## Channels

| Channel | Tag | Notes |
|---|---|---|
| Stable | `vX.Y.Z` | Full release, marked Latest |
| Preview / Beta | `vX.Y.Z-preview` | Pre-release, AppImage + installers |

Windows / macOS artifacts are built by GitHub Actions (`release` workflow) — nobody needs to sit on those OSes.

## Cut a release

```sh
pnpm typecheck && pnpm test          # gate
node scripts/release.mjs vX.Y.Z-preview
```

Replace the placeholder tag with the next intended version. At the current snapshot,
`v0.1.4` is already Stable and `v0.1.3` is the latest Preview; do not move or overwrite
either published tag.

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

`v0.1.2` is the current downloadable Latest. `v0.1.4` is a Pre-release: clean
macOS extract cannot resolve `@deepseek-ai/dsh-app-boot`. Do not send users to
those desktop assets.
The current code line is `0.1.4`; later `main` commits may contain documentation or
verification fixes that are not in the already published assets. Validate the exact
Release downloads separately from source or CI:

| Endpoint | Exact artifact / path | Required flow |
|---|---|---|
| Windows Desktop | `DSH.Community.Setup.0.1.4.exe` | clean VM → install → first launch → key → new/resume → plugin → restart |
| macOS Desktop | `dsh-community-0.1.4.dmg` | clean host → install → first launch → key → new/resume → plugin → restart |
| WSL/Linux Terminal | `dsh-community` / `pnpm tui` | clean WSL/Linux → key → new/resume → plugin → restart |
| Linux AppImage | `dsh-community-0.1.4.AppImage` | optional artifact smoke; not the primary Linux endpoint |

The gate must also cover uninstall/reinstall, upgrade, missing key, bad network, and
broken or interrupted Runtime extraction. Record Official Web ↔ WSL/Linux TUI ↔
Windows/macOS Desktop Session sharing and the exact asset filename plus SHA256.
`artifact-smoke` is only a partial install / first-ready / missing-key check; it is not
a full user loop. The latest run
([31935679026](https://github.com/kamanager2012/dsh-community/actions/runs/31935679026))
passed the macOS exact job but failed the Windows exact job. Until the failure is
understood and a later Latest smoke plus real-machine loop passes, the gate remains
`[UNVERIFIED]`. A green unit test or a main-source smoke is not that evidence.

## Rules

- Never publish workspace packages to npm.
- Do not attach the 600MB `linux-unpacked` tree; attach the AppImage / installers.
- A failed platform job does not block the others; fix it in a follow-up patch release.
- Never move or retag a published `vX.Y.Z`. If the bits are wrong, cut `vX.Y.Z+1`. The publish job refuses to overwrite an existing GitHub Release.
