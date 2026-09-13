# Architecture

ACS implements a layered defense architecture with a language-agnostic shared core and agent-specific adapters.

## System Overview

```
┌─────────────────────────────────────────────────────┐
│                  Shared Core (~/.acs_core/)          │
│                                                     │
│  guard.py          Bash & Git pattern matching      │
│  paths.py          Forbidden filesystem roots       │
│  violations.py     Sliding window + lock mechanism  │
│  audit.py          JSONL audit logging              │
│  structural.py     Code structure validation        │
└──────────┬──────────────────────────────────────────┘
           │
    ┌──────┼──────┬──────┬──────┬──────┬──────┬──────┐
    ▼      ▼      ▼      ▼      ▼      ▼      ▼      ▼
 Claude  Codex  Gemini Cursor Qoder  Hermes Open  CodeBuddy
  ACS    CACS   GACS   CrACS  QACS   HACS   OACS   BACS
 Python Python Python Shell  Python Python TS     复用ACS

Agent Hooks (~/.{agent}/hooks/)    ← Hook scripts
Agent Runtime (~/.{agent}/runtime/) ← State files
Agent Config  (~/.{agent}/config.*)  ← Agent settings
```

## Component Design

### 1. Shared Core (`acs_core/`)

Language-agnostic safety primitives. No agent-specific code. No external dependencies.

| Module | Responsibility |
|--------|---------------|
| `guard.py` | Compile regex patterns for dangerous Bash and Git commands. `check_bash(command) → str|None`. Returns block reason or None if safe. |
| `paths.py` | Define `FORBIDDEN_ROOTS` (14 system directories). `is_forbidden_path(path) → str|None`. Returns matched root or None. |
| `violations.py` | Sliding window violation tracking. `add_violation()` scores and accumulates. `should_lock()` checks thresholds. SHA-256 integrity chain. |
| `audit.py` | JSONL audit log. Structured logging of all hook decisions. |
| `structural.py` | Validates code structure for hook scripts. Prevents incomplete or tampered deployments. |

### 2. Adapters (`adapters/{agent}/`)

Thin glue layer (typically <200 lines) that:
1. Translates agent-specific hook JSON to shared core function calls
2. Maps agent event names (PreToolUse, PostToolUse, etc.)
3. Writes agent-specific deny responses (markdown compliance)
4. Manages agent-specific runtime directories

### 3. Hook Scripts (`versions/v1.5.0/` → v1.5.0)

Complete hook deployment for Claude Code / CodeBuddy Code. Unpacked by `install.sh` from `versions/v1.5.0/` → `~/.{agent}/hooks/`.

### 4. Runtime State (`~/.{agent}/runtime/`)

| File | Purpose |
|------|---------|
| `ACTIVE_TASK.json` | Current task ID and scope (allowed directories) |
| `VIOLATIONS.json` | Sliding window violation events with timestamps |
| `LOCKED` | Lock file (existence = system locked) |
| `INTEGRITY.json` | SHA-256 hash chain for tamper detection |
| `MODE.json` | Operation mode (ACTIVE / RESEARCH) |

## Hook Execution Flow

```
Agent Tool Call
       │
       ▼
PreToolUse Hook Event (stdin JSON)
       │
       ▼
hook_orchestrator.py    ← Dispatch to relevant guard
       │
       ├── Bash tool → check_bash(command)
       │                ├─ clean_command() (remove quotes/heredocs)
       │                ├─ DANGEROUS_BASH patterns
       │                └─ GIT_DESTRUCTIVE patterns
       │
       ├── Write/Edit  → check_write(file_path)
       │                ├─ is_self_protect()
       │                ├─ is_protected()
       │                ├─ resolve_zone()
       │                └─ scope check
       │
       └── Result → {"allowed": true} or {"permissionDecision": "deny"}
```

## Sliding Window Lock

```
Violations accumulate with weighted scores:
  SYSTEM:    100 → instant lock
  DELETE:     60 → near-lock
  WRITE:      25 → 3 to lock
  EXEC:       10 → 4 to lock

Window: 600s sliding window
  Window score ≥ 80  → LOCK
  Total score ≥ 150  → HARD LOCK
  Events decay after 600s

Unlock requires human confirmation:
  acs_lite.py unlock --confirm
```

## Cross-Agent Consistency

All adapters share the same core, so:
- `rm -rf /` is blocked identically on Codex, Claude, Gemini, etc.
- Violation scoring is consistent across agents
- Lock state is per-agent (Codex unlock doesn't affect Claude)
- Audit logs are per-agent but share the same format (JSONL)

## Security Boundaries

```
┌──────────────────────────────────┐
│  User (Human)                    │  Trusted
│  ─ can run unlock --confirm      │
│  ─ can modify ACS files manually │
├──────────────────────────────────┤
│  ACS System                      │  Self-protected
│  ─ hooks/    : agent cannot write│
│  ─ runtime/  : append-only       │
├──────────────────────────────────┤
│  Project Files                   │  Scope-gated
│  ─ within scope   : allowed     │
│  ─ outside scope   : blocked    │
├──────────────────────────────────┤
│  System Files                    │  Always blocked
│  ─ /etc, /usr, /bin, etc.       │
└──────────────────────────────────┘
```
