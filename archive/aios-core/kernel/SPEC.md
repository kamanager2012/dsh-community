# AIOS Core — Formal Execution Model v1.1

## State Derivation Spec

The core invariant of the system:

```
state = f(audit_log[0..n])
```

For any point `n` in the audit log, the complete runtime state can be
deterministically reconstructed by replaying entries 0..n.

Reliability verdicts follow the same rule. They are **derived state**, not an
independent mutable record:

```
reliability_verdict = g(frozen_task_contract, verification_evidence)
```

This avoids a second source of truth. The audit log persists the frozen plan
(including its optional Task Contract) and the structured VerificationReport
(including evidence). Replay recomputes the same PASS / FAIL / INCOMPLETE
verdict that the live reconciler used.

### State Derivation Rules

| Audit Entry Phase | State Mutation |
|---|---|
| PLAN | `state.plan = entry.plan; state.plan.frozen = true` |
| EXECUTE | `state.execResult = entry.execResult` |
| VERIFY | `state.verifyReport = entry.verifyReport` |
| VERIFY + contracted task + verify pass | derive reliability verdict from contract + evidence |
| COMMIT | `state.decision = "COMMIT"; state.memoryCommitted = true` |
| ROLLBACK | `state.decision = "ROLLBACK"; state.memoryRolledBack = true` |
| DONE | `state.terminal = true` |

### Acceptance Invariants

1. **COMMIT_AFTER_VERIFY_PASS** — COMMIT requires `verifyReport.status = "pass"`.
2. **CONTRACT_COMMIT_AFTER_RELIABILITY_PASS** — when a Task Contract exists, COMMIT additionally requires derived reliability status `PASS`.
3. **MISSING_REQUIRED_EVIDENCE_IS_INCOMPLETE** — absent required evidence produces `INCOMPLETE`, never PASS.
4. **FAILED_REQUIRED_EVIDENCE_IS_FAIL** — failed required evidence produces `FAIL`.
5. **LEGACY_COMPATIBILITY** — tasks without a Task Contract retain the original verify-pass acceptance rule.
6. **RELIABILITY_IS_DERIVED** — the verdict is recomputable from the frozen plan contract and recorded verification evidence; it is not stored as a second authoritative field.
7. **ROLLBACK_CLEARS_STAGING** — ROLLBACK sets `memoryRolledBack = true`.
8. **DECISION_FROM_RECONCILER** — terminal decisions come from reconciler except scope/approval rejections.
9. **TERMINAL_NO_FURTHER_TRANSITIONS** — terminal states do not have non-terminal transitions after them.
10. **PLAN_FROZEN_AFTER_PLAN** — plan is frozen before EXECUTE.
11. **EXECUTE_REQUIRES_PLAN** — EXECUTE requires `plan != null`.

### Reliability Contract

A Task Contract specifies acceptance evidence without prescribing agent
reasoning or creating another agent loop.

Current evidence kinds:

- `build`
- `test`
- `lint`
- `e2e`
- `diff`
- `invariant`
- `policy`
- `artifact`

Verdicts:

| Verdict | Meaning | Acceptance |
|---|---|---|
| PASS | all required evidence is present and passing | eligible for COMMIT |
| FAIL | one or more required evidence items or thresholds failed | ROLLBACK |
| INCOMPLETE | required evidence is absent | ROLLBACK |

The legacy verifier remains a hard gate. A Task Contract can make acceptance
stricter; it cannot override a failed build/test/lint/e2e verification pass.

### Hash Chain

Each audit entry produces a chained fingerprint:

```
fp[0] = H("genesis" | canonical(entry[0]))
fp[n] = H(fp[n-1].hash | canonical(entry[n]))
```

Chain verification: recompute each `fp[n]` and verify `prevHash` linkage.
Because contract and evidence are included in the audited plan/verification
objects, the inputs to the reliability verdict are also covered by the audit
fingerprint.

### Failure Classification

Every failure is classified into one of 7 categories:

| Category | Recoverable | Max Retries | Example |
|---|---|---|---|
| transient | yes | 3 | ETIMEDOUT, rate limit |
| deterministic | no | 0 | build failure, logic bug |
| permission | no | 0 | scope rejection, approval denied |
| corruption | no | 0 | checksum mismatch, invariant violation |
| partial_success | yes | 1 | some tests pass, some fail |
| resource | no | 0 | limits exceeded |
| unknown | no | 0 | unclassified |

Recovery decision: `shouldRetry(failure, attempts) = failure.recoverable && attempts < failure.maxRetries`

### Execution Tiers

| Tier | Name | IO Permitted | Commit |
|---|---|---|---|
| 0 | dry-run | none | no |
| 1 | shadow | read + staging | no |
| 2 | production | full | yes |

### Schema Versioning

Every audit entry carries `_v` field (current: 1).
Backward compatibility: replay engine auto-upgrades entries via `upgradeEntry()`.
Forward compatibility: entries with `_v > CURRENT_SCHEMA_VERSION` are rejected.

Adding derived replay fields does not require an audit schema bump because no
new authoritative audit field is introduced.
