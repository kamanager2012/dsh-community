# DeepSeek Harness Handbook

> An engineering, acceptance, and operations guide for DeepSeek Harness.

See the [English edition status and translation rules](translation-status.md).

DeepSeek Harness, usually invoked as `dsh`, runs agent tasks with models, tools,
workspaces, sessions, permissions, approvals, and user interfaces. This handbook
focuses on making those tasks bounded, observable, recoverable, and externally verifiable.

## What this handbook adds beyond search

Search and the upstream documentation remain the source of truth for current commands,
fields, and capabilities. This handbook adds the part that is easy to lose across
separate pages: a practical sequence for choosing a boundary, narrowing a failure,
recovering a session, and accepting an agent result with evidence.

It is therefore a guide to using dsh well, not a promise that a static page is newer
than the installed version.

## Choose a route

| Your goal | Start here |
| --- | --- |
| Understand what dsh is | [What is dsh?](00-overview/what-is-dsh.md) → [Five-layer model](00-overview/harness-five-layers.md) |
| Install and run it | [Installation](01-installation/README.md) → [First Web UI task](02-web-ui/first-run.md) |
| Run a scripted task | [CLI commands](03-cli/commands.md) → the Chinese [headless CLI guide](https://kamanager2012.github.io/deepseek-harness-handbook/content/automation/headless-cli/) |
| Configure DeepSeek | [Official Provider](04-providers/deepseek.md) → the Chinese [Provider guide](https://kamanager2012.github.io/deepseek-harness-handbook/content/04-providers/) |
| Deliver a code change safely | [Main workflow](05-workflows/from-blank-to-delivery.md) |
| Diagnose a Provider failure | [Provider troubleshooting](04-providers/troubleshooting.md) |
| Recover or clean up a Session | [Session recovery](07-sessions/recovery.md) |
| Accept a result with external checks | [Review and acceptance](05-workflows/review-and-acceptance.md) |
| Find common failure patterns | [FAQ](12-reference/faq.md) |
| Review permissions and data flow | [Security](06-security/README.md) → the Chinese [security chapters](https://kamanager2012.github.io/deepseek-harness-handbook/content/06-security/) |
| Look up a term | [Glossary](12-reference/glossary.md) |
| Understand the community ecosystem | [Community ecosystem](00-overview/community-ecosystem.md) |
| Historical Labs freeze notes | [Labs handoff](11-operations/community-labs-handoff.md) |

## Five-minute start

```bash
npx @deepseek-ai/dsh web
```

Open `http://127.0.0.1:3080`, configure a Provider under **Settings → Models**,
select a clean or disposable workspace, and begin with a read-only task.

```text
Goal: summarize the repository structure, key packages, and test entry points.
Scope: read only the selected workspace.
Do not: create, modify, or delete files; install dependencies; access the network;
or access paths outside the workspace.
Evidence: cite the files behind important conclusions and separate facts from inferences.
Stop: ask before writing, installing, using the network, or expanding permissions.
```

## Operating principles

- Establish a baseline before allowing changes.
- Treat workspace, credentials, tools, network access, and approvals as separate boundaries.
- The agent's final message is not an acceptance result; inspect the diff, tests, exit codes, and data flow.
- Examples in this handbook are templates, not fabricated execution reports.
- Check the installed version's `--help` output and upstream documentation when commands or fields may have changed.
- Treat the AI knowledge package as a traceable static index, not as a replacement for live search.

The source repository and the AI retrieval package are available from the [public GitHub project](https://github.com/kamanager2012/deepseek-harness-handbook).
