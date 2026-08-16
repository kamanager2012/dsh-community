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
2. **Windows** — NSIS installer (`DSH Community Setup x.y.z.exe`) + zip + sha256
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

## Rules

- Never publish workspace packages to npm.
- Do not attach the 600MB `linux-unpacked` tree; attach the AppImage / installers.
- A failed platform job does not block the others; fix it in a follow-up patch release.
