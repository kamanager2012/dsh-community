# Community Labs Reality Gate

> Evidence entry for experimental capabilities, not a release note. Snapshot: 2026-08-16.

[简体中文](reality-gate.md) · [Back to English README](../README.md) · [Canonical Product](https://github.com/kamanager2012/dsh-community) · [Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/en/)

## What this page separates

Suite contains fast-changing, high-risk, or upstream-contract-dependent experiments. The Reality Gate separates “code exists,” “adapter tests pass,” and “a real Runtime capability has been proven.”

A README, a green unit test, or a successful fallback is not enough to label a capability `[REAL]`.

## Current evidence matrix

| Capability / gate | Status | Current meaning |
| --- | --- | --- |
| Build, unit, and contract tests | `GREEN` | The repository build and test path runs |
| Shell fail-closed | `[FAIL-CLOSED]` | Compound operators, redirection, substitution, and similar combinations enter approval or rejection paths |
| `SessionEvent.data` adapter | `[REAL]` / adapter | Structured-envelope fixtures and decoder tests exist; this is not Runtime E2E |
| Pre-enqueue fallback guard | `[REAL]` / failure path | Automatic replay is forbidden after a prompt is enqueued or active |
| True SDK runtime E2E | `[UNVERIFIED]` | Still needs real stdio JSON-RPC, prompt, event stream, final response, and hard `executionMode === sdk_jsonrpc` assertion |
| Upstream contract probe CI | `RED` | A local probe passing is not the same as a stable upstream CI job |
| Interactive approval | `[BLOCKED_BY_UPSTREAM]` | The client can classify risk, but the official SDK does not yet expose a complete server-to-client approval loop |
| Checkpoint | `[WORKSPACE-JAIL]` / `[PARTIAL]` | Workspace containment exists; records are still mainly process-lifetime memory and must not be described as durable undo |
| Official Session | `[READ-SAFE]` | `~/.dsh/sessions` is read-only; Suite data uses a separate directory |

## Run local evidence

```bash
pnpm install
pnpm run build
pnpm run test
npx tsx scripts/contract-checker.ts
```

Every result should record:

- the `@deepseek-ai/dsh` version and profile;
- whether the test is fixture/adapter coverage or a real official-Runtime launch;
- whether fallback was enabled;
- whether real `SessionEvent`, tool, and turn-end events were observed;
- exit codes, logs, and cleanup behavior on failure.

## Gates before dsh-community

A Labs capability must pass:

```text
Reality Gate
  → upstream contract
  → security boundary
  → true E2E
  → cross-platform smoke
  → failure-path test
  → documentation
  → Canary → Preview → Stable
```

Keep insufficiently evidenced work marked `[LABS]`, `[PARTIAL]`, or `[UNVERIFIED]`. Do not replace evidence with “production-ready,” “fully compatible,” or “fully secure.”

## Architectural boundary

The official Runtime owns the Agent loop, model/tool execution, official Session persistence, and core lifecycle. Suite owns the Bridge, normalization, experimental UX, diagnostics, and security validation; it must not vendor official core packages or maintain a second Runtime or Session source of truth.

Related entries:

- [Ecosystem handoff](ECOSYSTEM_HANDOFF.en.md)
- [Community README](https://github.com/kamanager2012/dsh-community/blob/main/README.en.md)
- [Current release status](https://kamanager2012.github.io/deepseek-harness-handbook/en/11-operations/community-release-status/)
- [Plugin compatibility registry](https://github.com/kamanager2012/dsh-community-plugins)
- [Official Runtime](https://github.com/deepseek-ai/deepseek-harness)
