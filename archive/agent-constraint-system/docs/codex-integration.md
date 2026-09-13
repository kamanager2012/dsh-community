# Codex CLI Integration Guide

ACS (Agent Constraint System) provides a dedicated Python adapter for Codex CLI �? CACS (Codex Agent Constraint System).

## Quick Install

```bash
# Install ACS core
npm install -g github:kamanager2012/agent-constraint-system

# Install for Codex CLI
acs install codex

# Initialize runtime
python3 ~/.codex/hooks/acs_codex.py init
```

## Architecture

```
Codex CLI Session
       �?
       �?
┌──────────────────────�?
�?  hooks.json          �?  <- Codex hook config (installed to ~/.codex/)
�?  PreToolUse events   �?
├──────────────────────�?
�?  Bash | Write | Edit �?
└──────────┬───────────�?
           �? stdin JSON
           �?
┌──────────────────────�?
�?  acs_codex.py        �?  <- CACS Adapter (~/.codex/hooks/)
�?  Python hook script  �?
├──────────────────────�?
�?  �? check_bash()      �?
�?  �? is_forbidden_path �?
�?  �? add_violation()   �?
�?  �? should_lock()     �?
└──────────┬───────────�?
           �? import
           �?
┌──────────────────────�?
�?  ~/.acs_core/        �?  <- Shared Core
�?  guard.py            �?     Dangerous Bash patterns
�?  paths.py            �?     Forbidden filesystem roots
�?  violations.py       �?     Sliding window + lock
�?  audit.py            �?     JSONL audit logging
└──────────────────────�?
```

## What It Protects

| Category | Examples |
|----------|---------|
| Dangerous Bash | `rm -rf /`, `kill -9`, `mkfs`, `dd`, `chmod 777 /etc`, fork bombs, `curl\|sh` |
| Destructive Git | `git reset --hard`, `git clean -fdx`, `git push --force` |
| Filesystem | Writes to `/etc/`, `/usr/`, `/bin/`, `/boot/`, `/sys/`, `/proc/`, `/dev/` |
| Self-Protect | Prevents modification of CACS system files |

## CLI Commands

```bash
# Check status
python3 ~/.codex/hooks/acs_codex.py status

# Unlock (requires human confirmation)
python3 ~/.codex/hooks/acs_codex.py unlock --confirm

# Full reset (requires human confirmation + force)
python3 ~/.codex/hooks/acs_codex.py reset --force --confirm
```

## Runtime Files

```
~/.codex/cacs_runtime/
├── violations.json      # Sliding window violation events
├── LOCK.json            # Lock state (exists = locked)
├── integrity.json       # SHA-256 integrity chain
└── tool-audit.jsonl     # Audit log
```

## Violation Scoring

| Category | Score | Description |
|----------|-------|-------------|
| SYSTEM | 100 | Dangerous system operation �? instant lock |
| SELF_PROTECT | 100 | Modifying CACS system files �? instant lock |
| DELETE | 60 | File deletion �? near lock |
| WRITE | 25 | Writing outside scope �? 3 to lock |
| EXEC | 10 | Bash outside scope �? 4 to lock |

**Thresholds**: window �? 80 locks system | window decay 600s

## Verification

Run the ACS benchmark against Codex to verify protection:

```bash
cd benchmarks
python3 runner.py --json > results.json
python3 report.py results.json
```

## Troubleshooting

### "No output when I run commands"
Check if hooks are enabled:
```bash
grep "hooks" ~/.codex/config.toml
```
Should contain `hooks = true` under `[features]`.

### "Module not found: guard"
Run `python3 ~/.codex/hooks/acs_codex.py init` to create the runtime directory and verify acs_core is installed.

### "Command blocked unexpectedly"
Check violation status:
```bash
python3 ~/.codex/hooks/acs_codex.py status
```
If locked, unlock with `--confirm`.

## Real-World Incident Case

### Temporary-copy deletion after semantic misunderstanding

**Incident**: Codex CLI recovered project files from a previous session into `dramatools/`. When it realized the files were in the wrong location, it `mv`'d them to `/tmp/dramatools-mistaken-copy-20260723`. When the user asked "为什么存�? tmp 里面?", Codex interpreted this as a deletion request and attempted `rm -rf /tmp/dramatools-mistaken-copy-20260723`.

**Why ACS should have caught this**:

1. **Asset Classification Failure**: Codex couldn't distinguish "recovered historical work" from "temporary garbage"
2. **Semantic Misunderstanding**: User's rhetorical question was interpreted as a deletion command
3. **No Verification Gate**: Moved files to `/tmp` without verifying destination copy existed
4. **No Risk Escalation**: `rm -rf` on unverified assets should trigger HIGH-RISK DESTRUCTIVE ACTION gate
5. **No Post-Error Safe Mode**: After misidentifying files once, risk threshold should have auto-elevated

ACS provides the destructive action gate and asset ledger capabilities that are evolving toward preventing this class of failure. The bash-020 scenario in our Level 2 benchmark now demonstrates that when assets are properly tracked in the ledger, ACS correctly blocks deletion of critical unverified assets.
