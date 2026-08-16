# Release order

Official `@deepseek-ai/dsh` is the **development foundation**. We build three Community endpoints on the pinned official runtime: WSL/Linux Terminal, Windows Desktop, and macOS Desktop. Official Web is not a Community product. Linux AppImage is a secondary artifact. See [community-endpoints.md](community-endpoints.md).

A newer official rc is an upgrade of that foundation (pin + contract extract), not a gate that pauses product work.

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

The script checks a clean tree, a free tag, and a matching CHANGELOG section, then builds the AppImage locally as a packaging sanity check and pushes the tag. The tag push starts the 3-OS `release` workflow:

1. **Linux** — typecheck + test + secondary AppImage + sha256. The Linux *product* is the Terminal, not this AppImage.
2. **Windows** — NSIS installer (`DSH Community Setup x.y.z.exe`) + sha256. This is a primary Community endpoint. Portable zip is deferred until NSIS is reliably green.
3. **macOS** — dmg + sha256. This is a primary Community endpoint.

The `publish` job collects all assets and creates the GitHub Release with the CHANGELOG section as notes. `-preview` tags are marked pre-release; plain tags become Latest.

## Artifact naming

```text
DSH Community Setup x.y.z.exe       Windows Desktop (primary)
dsh-community-x.y.z.dmg             macOS Desktop (primary, unsigned)
dsh-community-x.y.z.AppImage        Linux Desktop (secondary)
dsh-community-x.y.z-win-x64.zip     Windows portable (deferred)
```

The WSL / Linux Terminal endpoint is `dsh-community` from this repository, not a GitHub Release installer.

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

`v0.1.2` is the first three-OS build baseline. Current Latest may be a later tag.
A later `main` commit may contain reliability fixes that are not in already published
assets. Validate the exact Release downloads separately from source or CI:

```text
Windows clean VM  → Setup.exe → first launch → key → new/resume → plugin → restart
macOS clean host  → dmg       → first launch → key → new/resume → plugin → restart
WSL / Linux       → dsh-community (Terminal) → key → new/resume → plugin → restart
```

AppImage smoke is optional and does not define the Linux product.

The gate must also cover uninstall/reinstall, upgrade, missing key, bad network, and
broken or interrupted Runtime extraction. Record Web ↔ Desktop ↔ TUI Session sharing
and the exact asset filename plus SHA256. A green build or a main-source smoke test is
not evidence that the published Stable artifact passes this gate.

## Rules

- Never publish workspace packages to npm.
- Do not attach the 600MB `linux-unpacked` tree; attach the AppImage / installers.
- A failed platform job does not block the others; fix it in a follow-up patch release.
- Never move or retag a published `vX.Y.Z`. If the bits are wrong, cut `vX.Y.Z+1`. The publish job refuses to overwrite an existing GitHub Release.
