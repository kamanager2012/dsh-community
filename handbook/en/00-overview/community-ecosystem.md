# DeepSeek Harness Community ecosystem

> Project handoff and product-entry map. Baseline date: 2026-11-19 (Published Latest: `v0.2.2-rc.5`; Candidate Source: `v0.2.2-rc.5`; historical Pre-release: `v0.2.2-rc.3-community.1`).

The community project is not a fork of DeepSeek Harness and not another Agent Runtime.
The official [DeepSeek Harness Runtime](https://github.com/deepseek-ai/deepseek-harness)
remains the only execution core. Community infrastructure adds complementary distribution,
an E2EE multi-agent remote control plane, compatibility contracts, verified plugin
metadata, operational guidance, and security validation around it.

## Three conclusions

1. **The official Runtime is the engine.** It owns the Agent loop, model execution,
   tool execution, official Session persistence, Official Web, and Windows/macOS Desktop.
2. **`dsh-community` is the only canonical product.** Normal users download, install,
   and use it for complementary surfaces absent upstream.
3. **Suite, Marketplace, Plugins, and Edition are merged and retired as standalone repos.**
   The former `deepseek-harness-suite` is frozen Labs under `archive/deepseek-harness-suite/`
   and is not a download channel. Standalone Marketplace, Plugins, and Edition repos were
   merged in and deleted on 2026-09-13.

## Where users start

```text
Official DeepSeek Harness Runtime
  (owns Official Web + Windows/macOS Desktop)
            │
            ▼
       dsh-community (three complementary community endpoints)
        ├── WSL/Linux Terminal (dsh-community / TUI)
        ├── Linux AppImage (Published Latest binary asset)
        └── Android Remote Client (apps/android, [UNVERIFIED])
```

The formal download entry is
[`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest).
Published Latest is **`v0.2.2-rc.5`** (release commit `0a8009d0462042764ad67e87208df791f1f6180b`, synced 1:1 with `@deepseek-ai/dsh@0.2.2-rc.5`, verified via `artifact-smoke` [Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621)), superseding historical pre-release [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1) and `v0.2.2-rc.3`.
See [`docs/current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json),
[current release status](../11-operations/community-release-status.md), and the
[release runbook](../11-operations/community-release-runbook.md) for machine-readable identity
and evidence boundaries.

Under **Complementary Edition**:

- The **three Complementary Community endpoints** are **WSL/Linux Terminal**, **Linux AppImage**, and **Android Remote Client**. All three are published in Latest (`dsh-community`, `.AppImage`, and signed `-android-arm64-v8a.apk`); Android passes CI `x86_64` emulator E2EE acceptance while physical `arm64-v8a` handset telemetry stays `[UNVERIFIED]`.
- Windows and macOS Desktop installers belong upstream in `deepseek-ai/deepseek-harness` (retired from `dsh-community` after historical `v0.1.1-rc.2`; `--win` / `--mac` fail closed). Historical independent numbers `v0.1.2`–`v0.1.6` are not current downloads.
- Official Web and Win/macOS Desktop are kernel/upstream surfaces sharing `~/.dsh`, not Community endpoints.
- Around `~/.dsh`, `packages/remote-adapter` and `apps/remote-web` also provide a **Multi-Agent E2EE Remote Control Plane** (`dsh-community remote start --qr`) over Noise IK, LAN mDNS, WebRTC P2P, or self-hosted Blind Relay (`deploy/relay/`) supporting DSH, Claude Code, Codex CLI, OpenCode ACP, and read-only scoped Git diff review.

## Public repositories

| Repository | Role | Audience | Formal download entry? |
|---|---|---|---|
| [`dsh-community`](https://github.com/kamanager2012/dsh-community) | Canonical Product: Linux AppImage, TUI, E2EE control plane, diagnostics, compatibility, and releases | All users and maintainers | **Yes; the only one** |
| This repo `handbook/` (formerly `deepseek-harness-handbook`, merged in) | Knowledge / Evidence: installation, operations, acceptance, and version facts | Users, maintainers, and Agents | No |
| [`dsh-community` packages/marketplace](https://github.com/kamanager2012/dsh-community/tree/main/packages/marketplace) | Discovery / Distribution UX + compatibility catalog `catalog.json` | Users and plugin authors | No; not a Runtime |
| This repo `archive/deepseek-harness-suite/` (formerly `deepseek-harness-suite`) | Archived Labs; last Labs pin `0.1.0-rc.6`, not current Latest | Historical reference | No; do not install |

The former standalone repositories `dsh-marketplace`, `dsh-community-plugins`,
`dsh-community-edition`, and `deepseek-harness-suite` were merged into the
product repo and deleted on 2026-09-13.

## Official and community boundaries

| Official Runtime owns | Community layer owns |
|---|---|
| Agent loop and model execution | Linux AppImage / TUI distribution experience |
| Tool execution and Runtime lifecycle | Lifecycle wrapping, diagnostics, and compatibility |
| Official Session persistence and events | Reading, resuming, and E2EE projection of sessions |
| Official profiles, CLI, and plugin surface | Bridge normalization, registry metadata, keyless packaging |
| Official Web and Win/macOS Desktop | Complementary endpoints and supply-chain verification |

The community layer must not reimplement the Agent loop, maintain a second equivalent
Session source of truth, fork the official event vocabulary, or vendor official core
packages (`Official Source Ownership = 0`). Use an official capability when it exists;
add a community extension only for a verified gap.

## Registry and Marketplace

```text
dsh-community/packages/marketplace/catalog.json
        │ catalog / testedDsh / verification
        ▼
dsh-community/packages/marketplace
        │ browse / search / install UX
        ▼
official dsh plugin add chain
```

The catalog and the marketplace CLI both live in `dsh-community/packages/marketplace`.
Neither owns the Runtime or replaces the official plugin manager. The standalone
`dsh-community-plugins` repo was deleted after its content merged into
`catalog.json`.

Current evidence snapshot: the registry has 9 verified plugins. CI checks
shape, npm existence/version, `dist.integrity`, provenance, and repository reachability;
the compose workflow runs the official `dsh plugin add` chain and a composition assertion
per plugin (`testedDsh` is `0.2.2-rc.5` for 5/9 plugins; `@deepseek-harness-tui/dsh-tui@0.20.1` remains on `0.2.2-rc.3`, and 3 legacy plugins remain on `0.1.1-rc.2`). The
Marketplace CLI provides `list`, `search`, `info`, and `install`; `info` displays
digest/provenance and installation remains on the official chain.

Current release boundary: GitHub Actions `artifact-smoke` runs
[43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) (`v0.2.2-rc.3` Latest) and
[44005955539](https://github.com/kamanager2012/dsh-community/actions/runs/44005955539) (`v0.2.2-rc.3-community.1` Pre-release)
downloaded their exact Release assets and passed `resolve`,
`linux-appimage`, `android-apk`, `linux-terminal`, and `verify-signatures` (keyless cosign on all 12
assets); the WSL/Linux live model user loop (`new -> answer -> resume -> answer`) and cross-surface recovery passed in runs
[43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931) and
[43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) (`[REAL]`), while physical `arm64-v8a` Android handset telemetry remains `[UNVERIFIED]`.

## Reality language

Use explicit labels:

| Label | Meaning |
|---|---|
| `[REAL]` | Code, tests, and reproducible runtime evidence exist |
| `[PARTIAL]` | Some implementation exists but a known gap remains |
| `[LABS]` | Archived Community Labs only; not promoted to the product |
| `[PROBE]` | A probe observed behavior; stability is not established |
| `[FAIL-CLOSED]` | Unknown or high-risk behavior is rejected or requires approval |
| `[WORKSPACE-JAIL]` | Workspace containment and escape tests are present |
| `[BLOCKED_BY_UPSTREAM]` | The official Runtime or SDK lacks a required loop |
| `[UNVERIFIED]` | Real E2E, cross-platform, or failure-path evidence is missing |
| `[NOT_IMPLEMENTED]` | The capability does not currently exist |

Do not use “production-ready”, “fully secure”, or “100% compatible” without evidence.

## Maintainer links

- [Chinese ecosystem page](../../content/00-overview/community-ecosystem.md)
- [Current release status](../11-operations/community-release-status.md)
- [Community Labs handoff](../11-operations/community-labs-handoff.md)
- [Release checklist](../../content/11-operations/release-checklist.md)
- [Handbook repository guide](https://github.com/kamanager2012/dsh-community/blob/main/handbook/README.en.md)
