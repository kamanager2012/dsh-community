# ACS v1.5.0 Source Snapshot

**Created**: 2026-07-22
**Source**: `~/.claude/hooks/` (production deployment)
**Purpose**: Reproducible source snapshot — previously v5.x source existed only in
deployment, making diff/rollback/review impossible without live access.

## Files

28 files captured from `~/.claude/hooks/`:

| File | Type | Role |
|------|------|------|
| acs_lite.py | Engine | Main hook entry, scope checks, Bash guard, violation tracking |
| acs_paths.py | Security | Path resolution, zone protection, writable prefix checks |
| acs_violations.py | Security | Violation store, integrity chain, sliding window |
| acs_structural.py | Security | Structural integrity verifier |
| hook_orchestrator.py | Orchestrator | Multi-hook scheduler and config loader |
| orchestrator_config.json | Config | v5.0 hook registration (authoritative) |
| guard.py | Security | Bash guard pre-filter |
| filesystem_guard.py | Security | File system operation protection |
| proposal_guard.py | Security | Proposal audit |
| authority_invariant.py | Security | Authority invariance check |
| shadow_workspace.py | Security | Shadow workspace isolation |
| abi_guard.py | Security | ABI compatibility check |
| bash_guard.py | Security | Bash command interception |
| sed_guard.py | Security | Sed command interception |
| read_guard.py | Security | Sensitive file read interception |
| audit_hook.py | Audit | Operation audit log |
| agent_memory.py | Memory | Agent memory management |
| doc_memory_tracker.py | Memory | Documentation memory tracking |
| session_memory.py | Memory | Session memory management |
| token_budget.py | Budget | Token budget tracking |
| risk_engine.py | Security | Risk assessment |
| stability_report.py | Monitoring | Stability report |
| runtime_loop.py | Infrastructure | Runtime loop manager |
| acs-task.sh | Script | ACS task launcher |
| acs_task.sh | Script | ACS task launcher (alternate) |
| backup.sh | Script | Backup utility |
| block-edit.sh | Script | Block edit guard |
| caveman-statusline.sh | Script | Status line helper |

## Fixes included in this snapshot

This snapshot is a 1:1 mirror of the deployed `~/.claude/hooks/` as of 2026-07-22.
It includes all P0/P1 security fixes and P2/P3 improvements applied during the
v1.5.0 optimization round:

| Fix | File |
|-----|------|
| P0-2: CLAUDE_PROJECT_DIR privilege escalation | acs_paths.py |
| P0-3: tool_input type validation | acs_lite.py |
| P0-1: Hook crash/missing/timeout → deny for PreToolUse | hook_orchestrator.py |
| P1-1: _safe_resolve symlink follow fix | acs_paths.py |
| P1-2: read_guard substring bypass + bare filename exact match | read_guard.py |
| P1-3: _save tmp_path orphan fix | acs_violations.py |
| P2-2: Integrity chain compaction (1000 entry cap) | acs_violations.py |
| P2-3: load_violations() caching | acs_lite.py |
| P2-4: MODE_FILE mtime cache | acs_lite.py |

See `OPTIMIZATION_PLAN.md` in the repo root for full details.
