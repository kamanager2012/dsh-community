# Capability Preservation — Design Document

> Status: **Implemented in v1.7.0** (`acs_core/capability_ledger.py` + `guard._check_capability_safety` + Level 4 benchmark). Auto-discovery of hardcoded secrets is still future work; the ledger is populated via adapter CLI (`capability-track` / `capability-verify` / `capability-removable`).

## Problem

ACS currently blocks dangerous commands and destructive writes, but it does not
reason about **runtime capability dependencies**. An agent can remove, clear, or
relocate a credential (or any asset the running code depends on) without
verifying that a replacement is configured and working. The system then breaks
silently on the next call.

Real failure pattern:

1. Agent finds a hardcoded `OPENAI_API_KEY` in `.env` / `config/credentials.json`.
2. Agent (correctly) decides hardcoding is bad and removes/relocates the credential.
3. Agent does **not** migrate the key to an environment variable or verify the
   new source loads.
4. The next tool call that needs the key fails — the system has lost a capability
   it had before the agent touched anything.

This is not caught by the current guard:
- `rm .env` → allowed (non-recursive `rm`, not matched by the v1.6.1 recursive-rm rule)
- `mv config/credentials.json config/credentials.bak` → allowed
- `cp /dev/null .env` → allowed
- `: > .env` → allowed

See `benchmarks/scenarios/capability_preservation.json` for the honest failing
scenarios.

## Design

A **Capability Ledger** mirrors the existing `AssetLedger`
(`acs_core/asset_ledger.py`) and `VerifiedCopyProtocol` (`acs_core/verified_copy.py`):
a state machine advances only when a verification gate passes, and removal of the
old credential is blocked until the final state is reached.

### State machine

```
ACTIVE_HARDCODED_SECRET
        │  (replacement source configured, e.g. env var detected)
        ▼
REPLACEMENT_CONFIGURED
        │  (replacement credential loads + authenticates)
        ▼
REPLACEMENT_VERIFIED
        │  (a dependent workflow smoke-test passes using the new source)
        ▼
DEPENDENT_WORKFLOW_PASSED
        │  (old credential no longer referenced by any code path)
        ▼
OLD_SECRET_REMOVABLE   ──> delete/clear/relocate allowed
```

Until `OLD_SECRET_REMOVABLE` is reached, any of these on the old credential is
**BLOCKED** (or **CONFIRM** for low-severity cases):
- delete (`rm`, `git rm`)
- clear / truncate (`: >`, `cp /dev/null`, value overwrite)
- relocate (`mv`, rename)

### Decision gate (three-state, consistent with AssetLedger)

| Asset state | Delete / clear / relocate old credential |
|---|---|
| `ACTIVE_HARDCODED_SECRET` (no replacement) | BLOCK — runtime would lose capability |
| `REPLACEMENT_CONFIGURED` (not yet verified) | BLOCK — replacement not proven |
| `REPLACEMENT_VERIFIED` (no smoke test) | CONFIRM — ask user |
| `DEPENDENT_WORKFLOW_PASSED` | ALLOW (one-shot) |
| command scope > authorized scope | BLOCK |

### Integration points

Mirroring how `AssetLedger` is wired today
(`adapters/codebuddy/acs_codebuddy.py:handle_bash` / `handle_write`):

- **`handle_bash`** — before allowing `rm`/`mv`/`cp`/redirect on a tracked
  credential path, consult the Capability Ledger. This is the same hook where
  `check_bash_with_context` already consults `asset_ledger.is_safe_to_delete`.
- **`handle_write`** — a Write/Edit that overwrites or deletes a credential
  file path goes through the same gate (analogous to `is_self_protect_path`).

### Verification primitives (reuse existing)

- SHA-256 comparison from `verified_copy.py` (`verify_copy`) — to confirm a
  replacement file actually contains the expected material.
- `predict_final_content` + `verify_structural_change` from `structural.py` — to
  predict whether removing a credential line breaks the file structure or
  exports.

### Data model (sketch)

```python
@dataclass
class CapabilityEntry:
    path: str                 # e.g. ".env", "config/credentials.json"
    secret_id: str            # e.g. "OPENAI_API_KEY"
    state: str                # one of the 5 states above
    replacement_source: str   # e.g. "env:OPENAI_API_KEY"
    verified_at: float        # timestamp of REPLACEMENT_VERIFIED
    smoke_test: str           # command run at DEPENDENT_WORKFLOW_PASSED
    dependents: list[str]     # code paths referencing this secret
```

Persisted as `capability_ledger.json` in the agent runtime dir, atomic
tmp+rename (same pattern as `asset_ledger.py`).

## Why this is the right direction

Asset Ledger already proves the pattern: "understand asset state before
deciding." Capability Preservation extends that from *file safety* to *runtime
capability safety* — the same intellectual move that distinguishes ACS from a
regex blocker. The blanket `rm -rf` block (v1.6.1) is a stopgap; this is the
asset-aware replacement for the credential case.

## Out of scope for v1.7.0

- Static analysis to discover hardcoded secrets (use existing secret scanners).
- Cross-process capability tracking between multiple agents.
- Automatic smoke-test generation (user supplies the smoke-test command).
