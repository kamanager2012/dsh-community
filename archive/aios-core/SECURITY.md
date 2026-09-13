# Security Policy

## Scope

AIOS Core is a task-reliability kernel: task contracts, evidence gates,
deterministic replay, regression comparison, and vendor-neutral policy evals.
As the [README](README.md#canonical-policy-semantics) states explicitly,
`governor/scope.ts` and `governor/policy.ts` are a normalized semantic/test
surface, **not an OS security boundary**. AIOS does not sandbox processes,
enforce filesystem/network isolation, or replace a vendor runtime's own
permission engine.

In scope for a security report:

- A task can reach `COMMIT` (or bypass `ROLLBACK`) despite required evidence
  being missing, failing, or fabricated — an Evidence Gate bypass.
- The audit hash chain (`kernel/statehash.ts`, `governor/audit.ts`) can be
  tampered with, replayed out of order, or forged without detection.
- `replay.ts` derives a different reliability verdict than the live
  reconciler for the same audited inputs (a soundness bug, not just a bug).
- `governor/scope.ts` / `governor/policy.ts` parsing can be tricked into
  misclassifying a path, command chain, or elevated-command signal in a way
  that a vendor adapter would rely on for an allow/deny/ask decision.
- Canonical policy validation/normalization silently drops or reinterprets
  an explicit `deny`/`ask` rule.
- Any dependency-supply-chain issue flagged by `npm audit` at
  moderate-or-higher severity (see `.github/workflows/security-audit.yml`).

Out of scope (report upstream instead):

- Sandbox, filesystem, or network isolation of the coding agent itself —
  that is the responsibility of the vendor runtime (Codex, Claude Code,
  Cursor, etc.) per the project's stated non-goals.
- Model behavior, prompt injection, or jailbreaks against the LLM the agent
  runtime happens to call. AIOS never calls a model itself.
- Vulnerabilities in `agent-constraint-system` or `governor-core`; they are
  archived and superseded by this repository.

## Supported Versions

| Version         | Supported |
| --------------- | --------- |
| `main` / `master` (latest commit) | Yes |
| Tagged releases  | Best-effort, evaluate case by case |

AIOS Core does not yet publish stable version branches; treat the tip of
`master` as the only actively maintained line.

## Reporting a Vulnerability

Please **do not** open a public issue for a suspected security problem.

1. Preferred: open a [GitHub Security Advisory](https://github.com/kamanager2012/aios-core/security/advisories/new) (private to maintainers until resolved).
2. If that is not available to you, contact the maintainer through the
   email on the commit history of this repository, and include:
   - the affected module/file and, if applicable, a minimal contract +
     evidence input that reproduces the issue;
   - what decision/verdict was produced vs. what should have been produced;
   - whether the issue is reproducible with `npm run check`.

We aim to acknowledge reports within 5 business days and to share a remediation
plan or explanation within 14 days. Coordinated disclosure is welcome; please
allow a fix to land before public disclosure.

## Our Commitment

- Missing required evidence must never resolve to `COMMIT`. Any report
  demonstrating otherwise is treated as a P0 correctness/security issue.
- Fixes to the Evidence Gate, reconciler, or audit chain land with a
  regression test under `tests/` (or `shadow/`) that fails on the
  pre-fix code, per the project's fail-closed design constraints.
