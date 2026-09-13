# Version History

Prior development builds used inconsistent internal version numbers.
Versioning was normalized to Semantic Versioning starting with v1.5.0 on 2026-07-23.

## Mapping Table

| Current (SemVer) | Previous (Internal) | Date | Summary |
|------------------|---------------------|------|---------|
| v1.7.0 | — | 2026-07-30 | Capability Ledger (credential-preservation state machine) + Level 4 benchmark + recursive-rm asset-aware priority |
| v1.6.1 | — | 2026-07-25 | Dangerous-command fail-closed policy (recursive rm always blocked) + scoring on every Bash block |
| v1.6.0 | — | 2026-07-25 | Self-protect filesystem-level hardening (is_self_protect_path across all agent dirs) |
| v1.5.0 | v5.3.0 / v6.1.0 | 2026-07-22 | Asset Ledger + Safe Mode + 3-level benchmark |
| v1.4.0 | v5.0 | 2026-06-06 | Policy engine, multi-agent governance, hook orchestrator |
| v1.3.0 | v4.3 | (planned) | Standalone install, environment variables, relative paths |
| v1.2.0 | v4.2 | 2026-06-05 | Control flow refactor, clear_violations fix, audit zone fix |
| v1.1.0 | v4.1 | 2026-06-03 | Python rewrite, sliding window lock, zone partitioning |
| v1.0.0 | v1.0.0 | 2026-05-30 | Self-protect regex, SHA-256 integrity chain, project decoupling |
| v0.2.0 | v0.7.1 | 2026-05-30 | 7 CRITICAL + 6 HIGH fixes, 114 tests |
| v0.1.0 | v0.7.0 | 2026-05-29 | TypeScript+Python hybrid prototype, first audit |

## Versioning Rules

- **Major** (X.0.0): Breaking changes, complete rewrites
- **Minor** (X.Y.0): Significant feature additions (`.1` bump)
- **Patch** (X.Y.Z): Bug fixes and small improvements (`.0.1` bump)

## Single Version Source

All components share a single version defined in `VERSION` file at the repo root.
Adapters do not carry independent version numbers — they follow the ACS version.
