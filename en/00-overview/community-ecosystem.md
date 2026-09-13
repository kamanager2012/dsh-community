# DeepSeek Harness Community ecosystem

> Project handoff and product-entry map. Baseline date: 2026-08-21.

The community project is not a fork of DeepSeek Harness and not another Agent Runtime.
The official [DeepSeek Harness Runtime](https://github.com/deepseek-ai/deepseek-harness)
remains the only execution core. Community repositories add distribution, compatibility,
plugins, knowledge, diagnostics, and experiments around it.

## Three conclusions

1. **The official Runtime is the engine.** It owns the Agent loop, model execution,
   tool execution, official Session persistence, and core lifecycle.
2. **`dsh-community` is the only canonical product.** Normal users download, install,
   and use it.
3. **Suite is archived.** `deepseek-harness-suite` is frozen Labs, not a download
   channel. The standalone Marketplace and Plugins repos are archived too. New
   work lives in `dsh-community` and this handbook.

## Where users start

```text
Official DeepSeek Harness Runtime
            │
            ▼
       dsh-community
        ├── WSL/Linux Terminal
        ├── Windows Desktop
        ├── macOS Desktop
        ├── Linux AppImage
        └── Android (archived Labs / UNVERIFIED)
```

The formal download entry is
[`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest).
GitHub Latest is `v0.1.1-rc.2`, 1:1 with official kernel `@deepseek-ai/dsh@0.1.1-rc.2`.
Use the [current release status](../11-operations/community-release-status.md) and the
[release runbook](../11-operations/community-release-runbook.md) for the boundary.
Historical independent numbers `v0.1.2`–`v0.1.6` are pre-release, not a download.
The five Community endpoints are **WSL/Linux Terminal, Windows Desktop, macOS Desktop,
Linux AppImage, and Android**. The first four ship with Latest; the Android prototype
stays in archived Labs as `[UNVERIFIED]` and is not on Latest. Official Web is the
kernel's own UI, shares `~/.dsh`, and is not a Community endpoint.
Do not download a client from Suite (archived Labs). The standalone Marketplace,
Plugins, and Edition repositories were merged into the product repo and deleted
on 2026-09-13. The plugin catalog lives in the product repo at
`packages/marketplace/catalog.json`.

## Public repositories

| Repository | Role | Audience | Formal download entry? |
|---|---|---|---|
| [`dsh-community`](https://github.com/kamanager2012/dsh-community) | Canonical Product: Desktop, TUI, diagnostics, compatibility, and releases | All users and maintainers | **Yes; the only one** |
| [`deepseek-harness-handbook`](https://github.com/kamanager2012/deepseek-harness-handbook) | Knowledge / Evidence: installation, operations, acceptance, and version facts | Users, maintainers, and Agents | No |
| [`dsh-community` packages/marketplace](https://github.com/kamanager2012/dsh-community/tree/main/packages/marketplace) | Discovery / Distribution UX + compatibility catalog `catalog.json` | Users and plugin authors | No; not a Runtime |
| [`deepseek-harness-suite`](https://github.com/kamanager2012/deepseek-harness-suite) | Archived Labs; last Labs pin `0.1.0-rc.6`, not current Latest | Historical reference | No; do not install |

The former standalone repositories `dsh-marketplace`, `dsh-community-plugins`,
and `dsh-community-edition` were merged into the product repo and deleted on
2026-09-13.

## Official and community boundaries

| Official Runtime owns | Community layer owns |
|---|---|
| Agent loop and model execution | Desktop / TUI distribution experience |
| Tool execution and Runtime lifecycle | Lifecycle wrapping, diagnostics, and compatibility |
| Official Session persistence and events | Reading, resuming, and presenting official Sessions |
| Official profiles, CLI, and plugin surface | Bridge normalization, registry metadata, packaging, and safe integration |

The community layer must not reimplement the Agent loop, maintain a second equivalent
Session source of truth, fork the official event vocabulary, or vendor official core
packages. Use an official capability when it exists; add a community extension only for
a verified gap.

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

Current evidence snapshot `[待复核]`: the registry has 9 verified plugins. CI checks
shape, npm existence/version, `dist.integrity`, provenance, and repository reachability;
the compose workflow runs the official `dsh plugin add` chain and a composition assertion
per plugin. The Marketplace CLI provides `list`, `search`, `info`, and `install`; `info`
displays digest/provenance and installation remains on the official chain.

Current release boundary `[PARTIAL]`: GitHub Actions run
[32489762676](https://github.com/kamanager2012/dsh-community/actions/runs/32489762676)
downloaded the exact `v0.1.1-rc.1` Release assets and passed checksum, Windows/macOS install
and Runtime first-ready, and Linux TUI missing-key/no-TTY checks. This is still not the
full user loop; Session sharing, plugin restart, upgrade/reinstall, and network-failure
paths require separate evidence. Historical independent numbers `v0.1.2`–`v0.1.6` are
not a user download.

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
- [Handbook repository guide](https://github.com/kamanager2012/deepseek-harness-handbook/blob/main/README.en.md)
