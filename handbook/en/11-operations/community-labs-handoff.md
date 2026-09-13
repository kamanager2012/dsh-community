# Community Labs handoff

> Maintainer snapshot for **archived** `deepseek-harness-suite`. Date: 2026-08-16.
> The GitHub repository is frozen. Do not install from it. Do not open new work there.

`deepseek-harness-suite` **was** Community Labs, not a second user distribution. Before
the freeze it was used to validate official SDK transport, the Bridge, advanced TUI /
Desktop UX, security, Checkpoint, Undo, audit, and runtime probes.

For this snapshot, code/build/unit-contract tests and Reality Gate adapter/fixture/failure-path
tests are green; the upstream probe CI is still red; and true SDK runtime E2E remains unproven.

## Boundaries

- Do not reopen a six-repository product strategy. Live repos are community and handbook.
- Do not make Suite a download channel.
- Do not continue `dsh-community-edition` as a parallel product.
- Do not reimplement the official Agent loop or Session persistence.
- Do not vendor official core packages.
- Do not treat README claims, unit-test success, or fallback success as Runtime E2E.
- Unknown capabilities fail closed.
- Close current Reality Gate seams before adding new UI, commands, dashboards, or large architecture.

## Current status

| Capability | Status | Do not claim |
|---|---|---|
| Official Session isolation | `[REAL]` `[READ-SAFE]`: official `~/.dsh/sessions` is read-only; Suite data uses `~/.dsh/suite_sessions` | Full migration compatibility across every scenario |
| Checkpoint workspace jail | `[WORKSPACE-JAIL]`: canonical paths, existing ancestors, symlink escape, traversal, NUL, and control characters are checked; single-file snapshot memory is capped at 5MB | Durable rollback or crash recovery |
| Checkpoint persistence | `[NOT_IMPLEMENTED]`: records are mainly process-lifetime memory | Undo after restart |
| Capability Risk Engine | `[FAIL-CLOSED]`: `fs:*`, `process:*`, `net:*`, credential, Git, and system capabilities drive risk | A tool-name prefix is a complete policy |
| Shell policy | `[REAL]` (regression): `&&`, `;`, `|`, redirection, `$()`, backticks, and newlines are fail-closed and require approval | These tests are a complete shell parser or all-platform proof |
| Official SDK Bridge | `[LABS / SDK-ADAPTER]`: official SDK dependency, typed adapter, and pre-enqueue guard exist | Dependency, fixtures, or adapter tests prove SDK success |
| SDK JSON-RPC E2E | `[UNVERIFIED]`: the correct runtime entrypoint and `executionMode === sdk_jsonrpc` still need a no-fallback test | Fallback success is SDK success |
| SessionEvent adapter | `[REAL]` (adapter/fixtures): decode `event.type` and `event.data` for chunk, args, and result mappings | Hand-built fixtures are real Runtime E2E |
| Fallback replay safety | `[REAL]` (guard): `isPromptEnqueuedOrActive` blocks replay after prompt enqueue; signal termination is not success | A real SDK transport E2E is already proven |
| Runtime HITL | `[BLOCKED_BY_UPSTREAM]`: the SDK lacks the complete server-to-client approval loop | Client `requiresApproval` equals runtime approval |
| Dynamic contract probe | `[PROBE]`: observes CLI, profiles, and config invariants; upstream probe CI is currently RED | One probe run proves stable Contract CI |

## P0 sequence

1. Find the official JSON-RPC runtime entrypoint and add a no-fallback E2E with a hard
   `executionMode === sdk_jsonrpc` assertion.
2. Repair the upstream probe CI cold-start/contract workflow and report probe, contract
   diff, and runtime E2E as separate gates.

Shell fail-closed checks, the typed `SessionEvent.data` adapter, and the pre-enqueue
fallback guard are now regression surfaces, not unfinished P0 items. They do not replace
true SDK runtime E2E.

## Promotion gate

```text
Reality Gate
  → Upstream Contract Gate
  → Security Boundary Gate
  → Real E2E
  → Cross-platform Smoke
  → Failure-path Test
  → Documentation
  → dsh-community Canary
  → Preview
  → Stable
```

Suite remains a research source, not a release channel. Edition capabilities should be
merged into `dsh-community` and then archived.

## Required Agent report

```text
Status: [REAL] / [PARTIAL] / [LABS] / [PROBE] / [UNVERIFIED]
Scope: files and modules actually changed
Evidence: commands, tests, exit codes, E2E, and probes actually run
Unverified: mocks, fallbacks, upstream blocks, and unrun paths
Risk: replay, permission, workspace, failure-path, and cross-platform gaps
Next: the smallest gate-approved next step
```

Related pages: [Chinese handoff](../../content/11-operations/community-labs-handoff.md),
[ecosystem map](../00-overview/community-ecosystem.md), and the [release checklist](../../content/11-operations/release-checklist.md).
