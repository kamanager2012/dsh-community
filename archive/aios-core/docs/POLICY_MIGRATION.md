# Canonical Policy Semantic Migration

This note records what AIOS Core absorbed from `governor-core` and, equally important, what it deliberately did **not** absorb.

## Pinned source

- repository: `kamanager2012/governor-core`
- source revision: `99825eeab501ce4fdc250a3a3e0ec69e0396976c`
- relevant source files:
  - `src/scope.ts`
  - `src/policy.ts`
  - `tests/scope.test.ts`
  - `tests/adversarial.test.ts`

The migration is semantic, not a source-tree copy. The canonical implementation keeps AIOS's own public interfaces and default policy profile where practical.

## Absorbed semantics

- canonical policy schema validation and deterministic normalization
- explicit-empty policy overlay behavior
- project-relative path normalization and traversal rejection
- command-chain parsing
- quoted-literal handling
- live command-substitution inspection
- simple shell-variable indirection expansion
- mass-delete semantic detection
- shell write-target extraction
- elevated/general-purpose executor signals
- adversarial regression cases for the behaviors above

## Deliberately not migrated

- `GovernanceEngine` as a second runtime/control plane
- governor-core approval workflow as a new AIOS decision engine
- a second audit system
- hook installation/runtime product shell
- the broader governor-core default `policy.json` profile
- claims that command parsing is an OS security boundary

AIOS already has a state machine, reconciler, audit/replay and rollback model. Duplicating governor-core's runtime responsibilities would re-create the three-layer stack inside one repository instead of actually merging it.

## ACS decoupling

The canonical CLI now constructs `ScopeValidator` without reading ACS runtime files. `governor/scope.ts` depends only on the minimal legacy ACS structural interface when compatibility is explicitly requested; it does not import `AcsClient`.

Legacy `acs_client.ts` / `acs_bridge.ts` remain temporarily for compatibility and their historical tests. They are no longer canonical dependencies and may be removed in a later change after adapter migration is validated.

## Preserved default-policy behavior

This migration strengthens **parsing semantics** without silently replacing AIOS's default allow/deny profile with governor-core's broader policy profile. Policy-profile changes must be reviewed as separate behavior changes.

## Known residual gaps

The source adversarial suite explicitly documented classes of behavior that a command semantic layer cannot safely close on its own. They remain acknowledged limitations rather than being hidden by more regexes:

- arbitrary in-tree logic executed by an allow-listed interpreter/script
- code fed to an interpreter through stdin
- build-tool lifecycle scripts that can execute project-defined shell logic
- destructive-but-in-scope rewrites through otherwise legitimate tools
- in-tree overwrite/move semantics through broad filesystem tools

These require native vendor controls and/or OS-level isolation for a true execution boundary. Canonical policy semantics should produce stable decisions/evidence for testing and compilation; they must not claim to replace those boundaries.
