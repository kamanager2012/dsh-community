# Third-Party Agent Documentation Patterns

> A documentation-design reference, not a source of truth for DeepSeek Harness. Snapshot: 2026-08-16.

[简体中文](../../content/12-reference/third-party-doc-patterns.md) · [Sources and reading method](../../content/12-reference/sources.md) · [Community ecosystem](../../content/00-overview/community-ecosystem.md)

## Why compare them

OpenCode, Aider, and Pi demonstrate documentation structures that help users: complete a first successful run first, then go deeper into configuration, sessions, extensions, automation, and troubleshooting.

We borrow information architecture and executable examples, not code, prose, product names, or unverified capability claims. DSH commands, fields, versions, and Runtime behavior still come from the current official `--help`, package, source, and real runtime results.

## Patterns worth borrowing

| Pattern | User value | Our landing point |
| --- | --- | --- |
| Quick Start → first success | Reduces first-run cognitive load | `dsh-community` guide, installation, and first task |
| Explain configuration and permissions by task | Shows why approval is needed and what it affects | Security, Provider, workspace, and approval chapters |
| Separate sessions, settings, extensions, and SDK | Keeps CLI, Runtime, plugins, and integrations distinct | Sessions, plugins, automation, and Community Labs handoff |
| Symptom-first troubleshooting | Maps an error directly to the next action | Provider, CLI, Web, Session, and operations troubleshooting |
| Link examples to reference pages | Lets users do the task before reading every field | Workflows, command reference, templates, and FAQ |

## Reference material

- [OpenCode Agents](https://opencode.ai/docs/agents/): organization of agents, permissions, and tool boundaries.
- [OpenCode Permissions](https://opencode.ai/v2/docs/permissions): authorization rules by action, resource, and effect.
- [Aider Documentation](https://aider.chat/docs/): task-oriented navigation for installation, usage, providers, configuration, and troubleshooting.
- [Pi coding-agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md): Quick Start, sessions, settings, extensions, and CLI entry points.
- [Pi SDK / RPC](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md): separates SDK, process isolation, and RPC use cases.

These links are for learning public documentation structure and expression. They are not DSH compatibility guarantees and do not alter official Runtime ownership boundaries.

## Requirements for this ecosystem

- The formal user entry is always `dsh-community`; Suite is Labs and Edition is archived.
- Every capability uses evidence labels such as `[REAL]`, `[PARTIAL]`, `[LABS]`, `[PROBE]`, and `[UNVERIFIED]`.
- Command examples must run for the stated version; uncertain flags should direct users to `--help` first.
- Plugin documentation separates Registry verification metadata, Marketplace discovery UX, and the official install chain.
- Chinese and English pages keep the same facts, status, and links; translation must not silently add capability claims.

## Continue reading

- [Sources and reading method](../../content/12-reference/sources.md)
- [Current Community release status](../../content/11-operations/community-release-status.md)
- [Task entry points](../../content/tasks/index.md)
- [Command cheatsheet](../../content/12-reference/cheatsheet.md)
