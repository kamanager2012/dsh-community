# ARCHIVED

This repository is frozen. It is not a product and is not published to npm. The npm package name `aios-core` belongs to [SynkraAI](https://www.npmjs.com/package/aios-core), not this repo.

Canonical public outcome: [`kamanager2012/dsh-community`](https://github.com/kamanager2012/dsh-community). [中文说明](README.zh-CN.md).

---

# AIOS Core

> Agent Reliability Kernel — task contracts, evidence gates, deterministic replay, regression, and vendor-neutral evals for coding agents.

AIOS Core is converging the former three-layer **Agent Governance Stack** into one canonical reliability project. The goal is not to build another agent loop, sandbox, or model router. The goal is to prove whether an agent actually completed a software-engineering task under explicit acceptance conditions, then measure regressions across agent/model/policy versions.

## Core idea

```text
Task Contract
    ↓
PLAN → EXECUTE → VERIFY
                  ↓
             Evidence Gate
              ↙        ↘
          COMMIT      ROLLBACK
              ↓
        Audit / Replay
              ↓
          Regression

Canonical Policy ─→ Vendor Adapter / Native Controls
Policy Eval Corpus ─→ Agent/Vendor Observation ─→ Eval Report
```

A stronger model does not remove the need for verification. It changes what should be verified. AIOS focuses on **task outcome evidence and regression**, while native agent runtimes remain responsible for their own sandbox/network/permission enforcement.

## Reliability contract

A contract defines the minimum evidence required before a task can be accepted:

```ts
const contract = {
  version: 1,
  requiredEvidence: ["test", "build", "diff"],
  invariants: ["public-api-stable"],
  acceptance: {
    minTestsPassed: 20,
  },
};
```

The verifier emits structured build/test/lint/E2E/diff evidence. External adapters may add policy, artifact, or named invariant evidence. Named invariants require matching evidence such as:

```ts
{
  kind: "invariant",
  id: "public-api-stable",
  status: "pass",
  summary: "export surface unchanged",
}
```

The reliability gate produces:

- `PASS` — every required evidence item and named invariant is satisfied.
- `FAIL` — required evidence exists but fails acceptance.
- `INCOMPLETE` — required evidence is missing; the task must not be treated as complete.

Legacy tasks without a Task Contract retain the existing verify-pass behavior.

## Architecture

```text
aios-core/
├── kernel/
│   ├── runtime.ts       # sole state-machine driver (SSOT)
│   ├── planner.ts       # task → frozen plan
│   ├── executor.ts      # execution adapter boundary
│   ├── verifier.ts      # structured verification evidence
│   ├── reliability.ts   # task evidence gate + run regression comparison
│   ├── eval.ts          # vendor-neutral policy-eval result engine
│   ├── reconciler.ts    # sole deterministic COMMIT/ROLLBACK decision exit
│   ├── replay.ts        # deterministic audit replay + derived reliability verdict
│   ├── invariant.ts     # state invariants
│   ├── failure.ts       # failure taxonomy
│   └── statehash.ts     # execution fingerprint + hash chain
├── governor/
│   ├── policy.ts        # canonical policy schema / validation / normalization
│   ├── scope.ts         # deterministic path/command semantics
│   └── ...              # approval / rollback / audit / limits + legacy adapters
├── memory/              # project-state memory and staging
├── shadow/evals/        # provenance-pinned eval corpora; not shipped in npm
├── cli/
└── tests/
```

### Frozen state machine

```text
IDLE → PLAN → EXECUTE → VERIFY → COMMIT → DONE
                         │
                         └──────→ ROLLBACK → DONE
```

Reliability does **not** add states. Evidence is evaluated inside the existing VERIFY → decision boundary.

## Canonical policy semantics

`governor/policy.ts` is a pure, vendor-neutral policy data layer. It provides:

- strict schema validation
- deterministic trim/dedup normalization
- field-level overlays where an explicit `[]` remains empty rather than silently falling back to defaults
- optional `elevatedCommands`, `askPaths`, and `askCommands` hints for vendor adapters

`governor/scope.ts` consumes the same schema and provides deterministic semantics for:

- project-relative path normalization and traversal rejection
- command-chain splitting
- quoted-literal handling
- command substitution inspection
- simple variable-indirection expansion
- mass-delete signals
- shell write-target extraction
- elevated general-purpose executor signals

This layer is **not** an OS security boundary. It is a normalized semantic/test surface that adapters may translate into native vendor controls.

The default AIOS CLI now constructs the canonical `ScopeValidator` directly and does **not** instantiate or read ACS runtime state. Legacy ACS compatibility remains explicit opt-in through a minimal structural interface while old adapters are phased out.

Importantly, this convergence step strengthens parsing without silently replacing the existing AIOS default allow/deny profile with `governor-core`'s broader policy profile.

## Audit and replay

The formal invariant remains:

```text
state = f(audit_log[0..n])
```

Reliability verdicts are deliberately **derived**, not duplicated as another mutable audit field:

```text
reliability_verdict = g(frozen_task_contract, verification_evidence)
```

The audit already records the frozen plan/contract and structured verification evidence. Replay recomputes PASS/FAIL/INCOMPLETE with the same pure evaluator used by the live reconciler. This prevents two sources of truth while keeping the verdict inputs covered by the audit hash chain.

## Agent CI regression

`kernel/reliability.ts` compares task reliability runs by stable `taskId` and reports:

- regressions (`PASS → INCOMPLETE/FAIL`, `INCOMPLETE → FAIL`)
- improvements
- unchanged tasks
- candidate-missing tasks
- candidate-added tasks

This is aimed at **project-specific Agent CI**, not a generic leaderboard.

## Vendor-neutral policy evals

`kernel/eval.ts` evaluates observations produced by any agent/vendor adapter against stable cases. It distinguishes:

- `false_allow` — a deny case was allowed
- `false_deny` — an allow case was denied
- `unexpected_ask` — the runtime asked instead of matching the expected decision
- `missing_observation` — the adapter failed to produce a result

It reports accuracy, danger-block rate, false-positive rate, per-category results, and PASS→FAIL regression between versions. The evaluator executes **nothing** itself.

### ACS corpus migration

The useful asset from `agent-constraint-system` is being preserved under `shadow/evals/policy/acs-v1/` as a provenance-pinned corpus, not as a copied runtime.

The migration gate fixes the source revision and requires all **105** source scenarios to remain present with unique IDs. The source baseline's six known failures remain explicit, including four bypasses and two legitimate-cleanup false positives. They are not re-labeled as successes during migration.

## Convergence of the former stack

| Existing project | What survives in the canonical project |
|---|---|
| `agent-constraint-system` | benchmark corpus, known bypasses/false positives, constraint taxonomy, optional legacy adapter evidence |
| `governor-core` | canonical policy schema, parsing/normalization semantics, adversarial test lessons; not its generic GovernanceEngine product shell |
| `aios-core` | state machine, evidence verification, invariants, recovery, replay, rollback, project-state memory |

Native Codex/Claude/Gemini/other runtime security controls should be used where available rather than rebuilding another sandbox or permission engine.

## Install

```bash
git clone https://github.com/kamanager2012/aios-core.git
cd aios-core
npm install
```

## Usage

```bash
aios run "fix login bug" --project myapp
aios plan "fix login bug" --project myapp
aios status
aios replay --last
aios replay --task task_042
```

The existing CLI remains backward compatible at the command surface. Canonical execution no longer requires ACS runtime files to be present. Task-contract, reliability, eval, and policy APIs are exposed at the package level while CLI ergonomics remain deliberately narrow.

## Checks

```bash
npm run check
```

`check` runs the architecture guard, TypeScript type checking, and the full Vitest suite, including corpus migration integrity and canonical policy-boundary checks.

## Design constraints

- Runtime is the only state-machine driver.
- Reconciler is the sole decision exit and remains pure: no model calls, no IO.
- A Task Contract may make acceptance stricter; it may never bypass existing verification failures.
- Missing required evidence is never success.
- Named invariants are executable acceptance requirements, not documentation-only fields.
- Reliability verdicts are derived from audited inputs rather than duplicated as mutable truth.
- Canonical policy semantics are pure data/decision semantics, not a replacement sandbox.
- The default CLI/runtime/scope must not depend on concrete ACS runtime modules.
- Eval corpora are data; vendor execution lives behind adapters.
- Project memory stores project facts/decisions, not chats, model thoughts, or vector personality memory.
- Staging/snapshot isolate in-flight state; only COMMIT promotes state.

## Non-goals

AIOS Core does **not** aim to become:

- a new general-purpose agent loop
- a multi-agent mesh/orchestrator
- a replacement sandbox or network isolation layer
- a model router
- a vector-memory/personality system
- a cloud scheduler or autonomous economy

The target is narrower: **reliable execution acceptance and regression evidence for real coding-agent work.**

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the architectural hard limits
(`scripts/arch-guard.mjs`), design constraints, and test conventions enforced
in review and CI.

## Security

See [SECURITY.md](SECURITY.md) for what is in scope (Evidence Gate bypass,
audit-chain tampering, replay/reconciler soundness, scope/policy parsing) and
how to report a vulnerability privately.

## License

MIT — see [LICENSE](LICENSE).

---

[中文文档](./README.zh-CN.md)
