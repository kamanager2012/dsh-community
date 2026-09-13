# Current Community release status

> Snapshot date: 2026-08-29. Machine-readable source of truth:
> [`dsh-community/docs/current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json).
> This page adds evidence; it does not invent a second Latest / kernel pin.
> It does not replace the GitHub Release, Actions result, or installer smoke test.

## Version model

The community product number mirrors the official kernel. Do not invent an independent community number, and do not use `-community.N` on the current line.

| Layer | Current value | Meaning |
|---|---|---|
| Official core | `@deepseek-ai/dsh@0.1.1-rc.2` | Official kernel |
| Community product / `main` | `0.1.1-rc.2` | Same number as the official kernel |
| Published Latest | `v0.1.1-rc.2` | GitHub Latest; the only normal download |
| Historical independent numbers | `v0.1.2`–`v0.1.6` | Old independent numbers, now pre-release, not a download |

Desktop and TUI must show the same identity badge:

```text
DeepSeek Harness Community v0.1.1-rc.2 [Official Core: @deepseek-ai/dsh@0.1.1-rc.2]
```

## User choice

The formal entry is [`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest).
Normal users download [`v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.1-rc.2).
Do not treat historical independent numbers `v0.1.2`–`v0.1.6` as the current download.

Published `v0.1.1-rc.2` assets (use the exact names on the Release page):

- `dsh-community-0.1.1-rc.2.AppImage` + `.sha256`
- `DSH.Community.Setup.0.1.1-rc.2.exe` + `.sha256`
- `dsh-community-0.1.1-rc.2.dmg` + `.sha256`

The five Community endpoints are WSL/Linux Terminal, Windows Desktop, macOS Desktop, Linux AppImage, and Android.
The first four ship with Latest. Android stays `[UNVERIFIED]` in archived Labs and is not on the formal download page.
Official Web is the kernel's own UI, shares `~/.dsh`, and is not a Community endpoint.

## Three-platform Release Gate

Observed for this snapshot; the full user loop remains `[待复核]`:

| Gate | Status | Evidence boundary |
|---|---|---|
| Normal `dsh-community` CI | `[待复核]` | Passing main CI does not prove installer readiness |
| Release assets | `[REAL]` | `v0.1.1-rc.2` has an AppImage, dmg, and Windows Setup, each with SHA256 |
| artifact-smoke | `[PARTIAL]` | [Run 32579569995](https://github.com/kamanager2012/dsh-community/actions/runs/32579569995) passed resolve, Windows, macOS, and Linux jobs |
| Official Runtime staging / installer | `[PARTIAL]` | Real v0.1.1-rc.2 Windows/macOS assets installed and reached Runtime readiness; the full lifecycle is not covered |
| Three-OS release gate | `[PARTIAL]` | Real-asset checksum, desktop first-ready, and Linux TUI failure paths passed; the full user loop remains open |

```text
tag
  → Linux / Windows / macOS build
  → artifact + SHA256
  → publish GitHub Release
```

The next goal is not another independent version number: add Session, plugin, upgrade/reinstall, network-failure, and first-conversation evidence beyond exact-artifact smoke.

## Latest vs current main

`v0.1.1-rc.2` is current Latest. Later `main` commits may contain docs or smoke fixes that are not in the tagged installer. A main-source smoke test or CI result cannot replace Release-asset review, so this page must not say the full user loop is verified.

## Distribution Reality Gate

Exact-release-artifact evidence only. First-launch smoke is `[PARTIAL]`; uncovered full-loop items stay `[待复核]`:

| Scenario | Status | Must prove |
|---|---|---|
| Windows clean VM + `DSH.Community.Setup.0.1.1-rc.2.exe` | `[PARTIAL]` | [Run 32579569995](https://github.com/kamanager2012/dsh-community/actions/runs/32579569995) downloaded, checked, silently installed, launched, and reached Runtime HTTP readiness |
| macOS clean host + `dsh-community-0.1.1-rc.2.dmg` | `[PARTIAL]` | Same run downloaded, checked, mounted, launched, and reached Runtime HTTP readiness |
| WSL/Linux clean host + `dsh-community` / `pnpm tui` | `[PARTIAL]` | Same run: Linux TUI help, version, missing-key doctor, sessions, no-TTY refusal |
| Session loop | `[待复核]` | New, resume, Official Web ↔ Windows/macOS Desktop ↔ WSL/Linux TUI share the same `~/.dsh` Session |
| Plugin / restart | `[待复核]` | Official `dsh plugin add` + `--dump-config` passed for 9 catalog plugins on `0.1.1-rc.2`; still-usable-after-restart and clear failure errors are not separately proven |
| Lifecycle recovery | `[待复核]` | Uninstall/reinstall, upgrade, offline, missing key, interrupted Runtime extract |
| Official Runtime staging / installer | `[PARTIAL]` | Real Windows/macOS first-ready passed; not a full install lifecycle claim |
| Android | `[UNVERIFIED]` | Archived Labs (now in this repo at `archive/deepseek-harness-suite/`); not on the Latest download list |

Conclusions must come from the files on the Release page plus install, Runtime staging, and user-loop results. Main-source smoke, ordinary CI, or README prose cannot replace that.

## Current project phases

| Phase | Estimated status | Current fact |
|---|---:|---|
| Phase 1 · Suite Reality Gate | about 80–90% `[待复核]` | Shell compound/metacharacter fail-closed, typed `SessionEvent.data` adapter, and pre-enqueue fallback guard have progressed; True SDK runtime E2E is not proven |
| Phase 2 · Edition → Community | 100% `[待复核]` | Session selector, `new` / `resume last` / `sessions` / `doctor` merged; Edition frozen and archived |
| Phase 3 · Cross-platform Release | `[PARTIAL]` | `v0.1.1-rc.2` assets and SHA256 published; exact-artifact smoke passed; full lifecycle still open |
| Phase 4 · Distribution Reality Gate | `[PARTIAL]` | artifact-smoke four jobs passed; Session, plugins, upgrade/reinstall, and full user loop not closed |
| Phase 4 workflow · Plugin supply chain | `[PARTIAL]` | 9 plugins `testedDsh` `0.1.1-rc.2` (compose); shape, npm existence/version, `dist.integrity`, provenance, reachability, and compose are in CI; restart-after-install is not separately proven |
| Phase 4 workflow · Marketplace UX | `[待复核]` | CLI is `list/search/info/install`; `info` shows digest/provenance |
| Phase 5 · Handbook drift CI | not started `[待复核]` | This page is the manual version-fact entry |

## Runtime version sources

```text
Official kernel: @deepseek-ai/dsh@0.1.1-rc.2
Community product / Latest: v0.1.1-rc.2
Historical independent numbers: v0.1.2–v0.1.6 (not a user download)
```

For CLI, Session, Event, SDK, or Plugin surface, check the installed/published package, current `--help`, exported config, contract snapshots, and real runs. Do not infer the current version from an old snapshot.

See:

- [`dsh-community` release workflow](https://github.com/kamanager2012/dsh-community/blob/main/.github/workflows/release.yml)
- [`dsh-community` changelog](https://github.com/kamanager2012/dsh-community/blob/main/CHANGELOG.md)
- [`dsh-community` contract snapshots](https://github.com/kamanager2012/dsh-community/tree/main/contracts)
- In-repo [`archive/deepseek-harness-suite/`](https://github.com/kamanager2012/dsh-community/tree/main/archive/deepseek-harness-suite) (formerly the standalone Labs repo, deleted)
- `dsh-community-edition` freeze commit `09eb1c0` (standalone repo deleted; no longer linkable)
