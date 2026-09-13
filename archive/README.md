# archive/

Frozen historical material kept for reference. Nothing in this directory is
part of the pnpm workspace, the vitest suite, or any CI build — it is excluded
by construction (workspace globs are root-anchored) and must stay that way.

## deepseek-harness-suite/

The former standalone `deepseek-harness-suite` repository — the frozen
"Community Labs" line, superseded by `dsh-community`, last Labs pin
`0.1.0-rc.6`. Its full code and commit history were merged into this
repository on 2026-09-13; the standalone repository was deleted the same day.

- Do not install from this directory. Canonical downloads remain
  [`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest).
- Branch tips of the former repository that were never merged into its `main`
  are preserved as tags `archive/suite/<branch>` (e.g.
  `archive/suite/work-probe-fix`).
- The in-tree `.github/` files are inert: GitHub only reads workflows from the
  repository root.

## aios-core / governor-core / agent-constraint-system

The frozen **Agent Governance Stack** lineage. `agent-constraint-system` was the
original command/path-level execution-governance project; `governor-core` was
the deterministic policy-engine layer; `aios-core` was the converged Agent
Reliability Kernel that absorbed the useful parts of the other two and declared
`dsh-community` as its canonical public outcome. All three repositories were
frozen upstream; their full code and commit history were merged into this
repository on 2026-09-13 and the standalone repositories were deleted the same
day.

- `aios-core/` — task contracts, evidence gates, deterministic replay and
  regression, and the vendor-neutral policy eval corpora
  (`shadow/evals/policy/`, including the migrated ACS `acs-v1` corpus).
- `governor-core/` — original policy/audit engine; its policy semantics live on
  inside `aios-core/governor/`.
- `agent-constraint-system/` — original constraint runtime and Levels 1–4
  benchmark material, preserved as provenance.
- Every former branch tip was already merged into its repository's default
  branch before deletion, so no tip tags were needed (unlike the suite archive).
- Original commit SHAs remain reachable unchanged: the handbook lab workspace
  pin `aios-core@6af8968` can be checked out from this repository's history.
- Do not install from this directory.
