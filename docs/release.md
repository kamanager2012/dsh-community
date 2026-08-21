# Release order

Official `@deepseek-ai/dsh` is the **development foundation**. We build TUI and Desktop on the pinned official runtime. A newer official rc is an upgrade of that foundation (pin + contract extract), not a gate that pauses product work.

Current official pin, Latest tag, Dual-Badge, and asset names live in
[`current-release.json`](current-release.json). Update that file in the same
commit as `pin.ts` when cutting a release. See [Version and identity
policy](version-policy.md).

## Channels

| Channel | Tag | Notes |
|---|---|---|
| Official-core mirror | `vX.Y.Z` or `vX.Y.Z-rc.N` | Community version exactly mirrors the official core; this is GitHub Latest |
| Community patch | `vX.Y.Z[-prerelease]-community.N` | Community-owned fix on the same official core; GitHub pre-release |

Windows / macOS artifacts are built by GitHub Actions (`release` workflow) — nobody needs to sit on those OSes.

## Cut a release

```sh
pnpm typecheck && pnpm test          # gate
node scripts/release.mjs v0.1.1-rc.1
```

Replace the example tag with the next intended community version. If the change
only advances the official core, use the exact official version. If it is a
community-only fix on the same core, increment `-community.N`.
The current download is `v0.1.1-rc.1` on
[releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest).
Do not download historical `v0.1.2`–`v0.1.6` as the current product. Never move
or overwrite a published tag.

The script checks a clean tree, a free tag, and a matching CHANGELOG section, then builds the AppImage locally as a sanity check and pushes the tag. The tag push starts the 3-OS `release` workflow:

1. **Linux** — typecheck + test + AppImage + sha256
2. **Windows** — NSIS installer (`DSH Community Setup x.y.z.exe`) + sha256. Portable zip is deferred until NSIS is reliably green.
3. **macOS** — dmg + sha256

The `publish` job collects all assets and creates the GitHub Release with the CHANGELOG section as notes. Official-core mirrors (`vX.Y.Z` or `vX.Y.Z-rc.N`) become Latest. Only `-community.N` / `-preview` / `-beta` tags are GitHub pre-releases.

## Artifact naming

```text
dsh-community-x.y.z[-prerelease].AppImage        Linux
DSH Community Setup x.y.z[-prerelease].exe       Windows installer
dsh-community-x.y.z[-prerelease]-win-x64.zip     Windows portable
dsh-community-x.y.z[-prerelease].dmg             macOS (unsigned preview)
```

Every artifact ships a `<file>.sha256` sidecar.

The source workflow templates the Windows file as `DSH Community Setup
<version>.exe`. GitHub may display spaces as dots. Always use the exact
filename shown on the Release page when verifying a published asset.

## Manual checks after a release

```sh
curl -sL https://api.github.com/repos/kamanager2012/dsh-community/releases/latest | head
```

All "download Community" links in every repo point at:

```text
https://github.com/kamanager2012/dsh-community/releases/latest
```

## Distribution Reality Gate

GitHub Latest is `v0.1.1-rc.1` (1:1 official core). Later `main` commits may
contain code or verification fixes that are not in the published download.
Validate exact Release downloads separately from source or CI. Use the exact
filename on the Release page (Windows Setup may appear with spaces or dots):

| Endpoint | Exact artifact / path | Required flow |
|---|---|---|
| Windows Desktop | `DSH Community Setup 0.1.1-rc.1.exe` | clean VM → install → first launch → key → new/resume → plugin → restart |
| macOS Desktop | `dsh-community-0.1.1-rc.1.dmg` | clean host → install → first launch → key → new/resume → plugin → restart |
| WSL/Linux Terminal | `dsh-community` / `pnpm tui` | clean WSL/Linux → key → new/resume → plugin → restart |
| Linux AppImage | `dsh-community-0.1.1-rc.1.AppImage` | community endpoint 4; CLI users still start at Terminal |
| Android | Labs APK / Termux | `[UNVERIFIED]`; not a Latest download |

The gate must also cover uninstall/reinstall, upgrade, missing key, bad network, and
broken or interrupted Runtime extraction. Record Official Web ↔ WSL/Linux TUI ↔
Windows/macOS Desktop Session sharing and the exact asset filename plus SHA256.
`artifact-smoke` is only a partial install / first-ready / missing-key check; it is not
a full user loop. Historical `v0.1.2` smoke
([32470195309](https://github.com/kamanager2012/dsh-community/actions/runs/32470195309))
does not cover `v0.1.1-rc.1`. Re-run `artifact-smoke` against the new tag; until
that run is green, this gate stays `[UNVERIFIED]` for the current Latest. A green
unit test or a main-source smoke is not that evidence.

## Rules

- Never publish workspace packages to npm.
- Do not attach the 600MB `linux-unpacked` tree; attach the AppImage / installers.
- A failed platform job does not block the others; fix it in a follow-up patch release.
- Never move or retag a published `vX.Y.Z`. If the bits are wrong, cut `vX.Y.Z+1`. The publish job refuses to overwrite an existing GitHub Release.
