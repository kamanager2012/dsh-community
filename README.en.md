# DeepSeek Harness Handbook

[简体中文](README.md) | **English**

> Engineering, acceptance, security, and operations guidance for DeepSeek Harness.

This repository organizes practical knowledge around the official
[DeepSeek Harness Runtime](https://github.com/deepseek-ai/deepseek-harness):
installation, Providers, workspaces, Sessions, tools, automation, permissions,
plugins, delivery review, and operational evidence. It does not replace the
upstream Runtime or invent a second command contract.

## Read online

- [English handbook](https://kamanager2012.github.io/deepseek-harness-handbook/en/)
- [Chinese handbook](https://kamanager2012.github.io/deepseek-harness-handbook/)
- [English translation status](en/translation-status.md)
- [Machine-readable AI catalog](ai/README.md)
- [Community ecosystem map](en/00-overview/community-ecosystem.md)
- [Current community release status](en/11-operations/community-release-status.md)
- [Community Labs handoff](en/11-operations/community-labs-handoff.md)

The Chinese edition currently contains the broadest reference coverage. The English
edition prioritizes high-value workflows, troubleshooting, security, and ecosystem
boundaries; it must preserve commands, identifiers, version warnings, and source links
without inventing runtime results.

## Choose a route

| Goal | Start here |
|---|---|
| Understand dsh | [What is dsh?](en/00-overview/what-is-dsh.md) → [Five-layer model](en/00-overview/harness-five-layers.md) |
| Install and launch | [Installation](en/01-installation/README.md) → [First Web UI task](en/02-web-ui/first-run.md) |
| Run a scripted task | [CLI commands](en/03-cli/commands.md) |
| Configure DeepSeek | [Provider setup](en/04-providers/deepseek.md) → [Troubleshooting](en/04-providers/troubleshooting.md) |
| Deliver a code change safely | [Main workflow](en/05-workflows/from-blank-to-delivery.md) → [Review and acceptance](en/05-workflows/review-and-acceptance.md) |
| Recover a Session | [Session recovery](en/07-sessions/recovery.md) |
| Review permissions and data flow | [Security](en/06-security/README.md) |
| Understand the community products | [Ecosystem map](en/00-overview/community-ecosystem.md) |
| Check the current release gate | [Community release status](en/11-operations/community-release-status.md) |
| Historical Labs freeze notes | [Labs handoff](en/11-operations/community-labs-handoff.md) |

## The community ecosystem

The official Runtime is the execution core. Around it, the community repositories
have separate responsibilities:

| Repository | Role | User-facing status |
|---|---|---|
| [`dsh-community`](https://github.com/kamanager2012/dsh-community) | Canonical Product: Desktop, TUI, diagnostics, compatibility, and releases | **Only normal download entry** |
| [`deepseek-harness-suite`](https://github.com/kamanager2012/deepseek-harness-suite) | Archived Labs | Frozen; do not install |
| `deepseek-harness-handbook` | Knowledge, evidence, and operations | This repository |
| [`dsh-community` packages/marketplace](https://github.com/kamanager2012/dsh-community/tree/main/packages/marketplace) | Discovery, install CLI, and `catalog.json` | In the product repo |

The former standalone repositories `dsh-marketplace`, `dsh-community-plugins`,
and `dsh-community-edition` were merged into the product repo and deleted on
2026-09-13.

Users should download only from
[`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest).
Suite, the standalone Marketplace, and the standalone Plugins registry are archived. Edition is an archive. None is a second Runtime or client.

## Evidence rules

- Treat the upstream repository, the installed `--help`, exported configuration, and
  actual runtime output as the source of truth for changing facts.
- Treat README text, a unit-test pass, or a fallback path as insufficient evidence for
  a real Runtime E2E claim.
- Mark partial, experimental, probed, blocked, or unverified behavior explicitly.
- Keep credentials out of Markdown, examples, logs, screenshots, and commits.
- Use disposable or recoverable workspaces for automation and first-run experiments.

## Local validation

```bash
python3 scripts/build_ai_catalog.py
python3 scripts/validate_ai_catalog.py
python3 scripts/validate_handbook.py
.venv/bin/mkdocs build --strict
```

The validation scripts check links, records, generated indexes, and sensitive-pattern
rules. They do not replace a real model call, cross-platform smoke test, or acceptance
review of a Runtime change.

## License and scope

This is documentation and evidence organization around the official project. The original
Markdown content, validation scripts, and generated AI catalog files in this repository are
available under the [MIT License](LICENSE). This does not extend to the upstream DeepSeek
Harness project, its official documentation, or any third-party material quoted or linked from
this handbook; those remain the property of their respective owners under their own terms.
