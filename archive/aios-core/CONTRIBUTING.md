# Contributing to AIOS Core

AIOS Core is a small, deliberately narrow reliability kernel (see the
[Non-goals](README.md#non-goals) in the README). Most contributions should
make the existing state machine, evidence gate, or audit/replay path more
correct — not add surface area. If a change needs a new top-level concept,
open an issue first and explain why the existing 7-state machine and
kernel/governor/memory/cli layering cannot express it.

## Before you start

```bash
git clone https://github.com/kamanager2012/aios-core.git
cd aios-core
npm install
npm run check
```

`npm run check` runs, in order: the architecture guard, `tsc --noEmit`, and
the full Vitest suite (`tests/` unit/integration + `shadow/` real self-shadow
runs). All three must pass before you open a PR; CI (`.github/workflows/ci.yml`)
runs the same command on Node 20.x and 22.x.

## Architectural hard limits (`scripts/arch-guard.mjs`)

These are enforced in CI, not just style suggestions. They exist because an
earlier iteration of this project (referenced in the guard's own error
messages as "v8.0") grew to 433 files and 366 compile errors and took 10 days
to unwind:

- **Total source files** across `kernel/`, `governor/`, `memory/`, `cli/`: ≤ 40.
- **Per-module file count**: `kernel/` ≤ 14; `governor/`, `memory/`, `cli/` ≤ 8 each.
- **Top-level directories** are limited to `kernel, governor, memory, cli, tests, scripts, docs, shadow`. Do not add a new one to work around a file-count limit.
- **`kernel/reconciler.ts` stays a pure function**: no `fs`, `fetch`, `axios`, `child_process`, or model-vendor SDK imports. It is the sole COMMIT/ROLLBACK decision exit and must stay testable without IO.
- **The `Phase` state machine is frozen at 7 states** (`IDLE, PLAN, EXECUTE, VERIFY, COMMIT, DONE, ROLLBACK`). A PR adding a state must justify why it cannot be expressed with the existing 7.
- **No value-level circular dependencies** between `kernel/`, `governor/`, `memory/`, `cli/`. Type-only circular imports (`import type`) are fine; anything that would matter at runtime is not.

If `npm run check` fails on one of these, the fix is almost always to change
fewer files or reuse an existing module rather than to raise the limit.

## Design constraints (not guard-enforced, but expected in review)

From the README, restated as review checklist items:

- `kernel/runtime.ts` is the only state-machine driver.
- A `TaskContract` may only make acceptance *stricter*; it must never bypass
  an existing verification failure.
- Missing required evidence must never resolve to a passing verdict.
- Named invariants require matching executable evidence, not a documentation
  comment claiming the invariant holds.
- Reliability verdicts are *derived* from audited inputs (`replay.ts` +
  `reliability.ts`); do not add a second, independently-mutable verdict field.
- `governor/scope.ts` / `governor/policy.ts` are semantic/test surfaces, not a
  sandbox. Do not describe a change there as adding "isolation" or "security" —
  describe it as "a vendor adapter can now correctly classify X".

## Tests

- Unit/integration tests live under `tests/`, mirroring the `kernel/`,
  `governor/`, `memory/`, `cli/` layout.
- `shadow/` runs the runtime against real rule-based planning and real
  `tsc`/`vitest` verification (self-shadow: the kernel manages its own
  development). These are slower; keep new scenarios in `shadow/tasks.ts`
  additive rather than duplicating the harness.
- A fix to the Evidence Gate, reconciler, or audit chain needs a regression
  test that fails on the pre-fix code — see [SECURITY.md](SECURITY.md) for why
  this is a hard requirement for that class of change, not just a nice-to-have.
- `npm run typecheck` (`tsc --noEmit`) catches classes of bugs (wrong
  constructor shapes, renamed methods) that a test suite with incomplete
  coverage will not; do not skip it locally even if `vitest run` is green.

## Commit / PR conventions

- Prefixes used in this repo's history: `feat:`, `fix:`, `docs:`, `ci:`,
  `chore:`, `refactor:`, `test:`. Keep the subject line under ~72 chars.
- Land features through a PR against `master` rather than pushing directly,
  so `CI` and `Dependency security audit` both report on the change before
  it merges.
- If a dependency change is required, run `npm audit --audit-level=moderate`
  locally first; CI will block on new moderate-or-higher advisories.

## Security-relevant changes

Do not open a public PR that demonstrates a live Evidence Gate bypass or
audit-chain forgery with enough detail to exploit it before a fix is
available. Follow the reporting process in [SECURITY.md](SECURITY.md) instead,
and reference the advisory from the eventual fix PR.
