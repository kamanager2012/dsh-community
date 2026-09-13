# Threat Model

## Attack Surface

ACS protects against threats originating from **autonomous coding agent behavior**. The threat model assumes a capable coding agent (LLM + tool execution) that has filesystem and command execution access, operating with the user's privileges.

### Threat Actors

| Actor | Capability | Motivation |
|-------|-----------|------------|
| **Malicious instruction** | User prompt is benign but agent hallucinates dangerous command | Accidental damage |
| **Prompt injection** | Third-party content in code/comments triggers unsafe behavior | Data exfiltration, system compromise |
| **Semantic misunderstanding** | Agent misinterprets user intent, executes destructive action | Accidental data loss |
| **Multi-agent confusion** | One agent misidentifies another agent's files as own | Cross-agent damage |

### Attack Vectors

#### 1. Direct Dangerous Commands

Agent executes explicitly harmful commands:
- `rm -rf /` or `rm -rf ~`
- `kill -9` on system processes
- Disk formatting (`mkfs`, `dd`)
- Permission escalation (`chmod 777 /etc`)

**Detection**: Regex pattern matching in `guard.py`

#### 2. Bypass Techniques

Agent attempts to circumvent string-matching guards:

| Technique | Example |
|-----------|---------|
| Base64 encoding | `echo c20gLXJmIC8= \| base64 -d \| sh` |
| Variable substitution | `CMD="rm -rf /"; $CMD` |
| Alias creation | `alias x='rm -rf /'; x` |
| Heredoc | `bash <<EOF\nrm -rf /\nEOF` |
| Python/Perl exec | `python3 -c "import os; os.system('rm -rf /')"` |
| String concatenation | `r"m" -"r"f /` |
| eval | `eval $(echo rm -rf /)` |
| Command substitution | `sh -c "$(echo cm0gLXJmIC8= \| base64 -d)"` |
| Octal escapes | `chmod \060\067\067\067 /etc/passwd` |
| find -exec | `find / -name '*.log' -exec rm -rf {} \;` |

**Detection**: Clean command (strip quotes, heredocs) + pattern match. Bypass resistance is a continuous improvement target.

#### 3. Filesystem Boundary Violation

Agent writes to protected filesystem zones:
- System configuration: `/etc/`, `/usr/`, `/bin/`, `/sbin/`
- Boot files: `/boot/`
- Kernel interfaces: `/sys/`, `/proc/`
- Block devices: `/dev/`
- Library paths: `/lib/`

**Detection**: Path prefix matching in `paths.py`

#### 4. Git History Destruction

Agent executes irreversible Git operations:
- `git reset --hard` (destroys uncommitted work)
- `git clean -fdx` (deletes untracked files)
- `git push --force` (overwrites remote history)
- `git checkout -- .` / `git restore -- .` (discards all changes)

**Detection**: Regex pattern matching

#### 5. Self-Protection Bypass

Agent attempts to disable or modify ACS components:
- Overwriting hook scripts
- Deleting or modifying runtime state files
- Clearing violation records
- Disabling integrity verification

**Detection**: Path-based protection + integrity chain verification

#### 6. Semantic Misunderstanding (Real Incident)

**Case: Asset Deletion After Intent Misinterpretation**

1. Agent recovers historical project files
2. Agent misplaces recovered files, moves them to `/tmp`
3. User asks "Why are they in /tmp?" (rhetorical question)
4. Agent interprets this as deletion request
5. Agent attempts `rm -rf /tmp/recovered-data/`

**Why standard guards miss this**:
- Command looks legitimate (cleaning `/tmp`)
- No regex pattern fires
- Path is not in `FORBIDDEN_ROOTS`
- User didn't explicitly say "delete"

**ACS Countermeasures Needed**:
1. **Asset Classification**: Track whether target directory contains user-recovered data
2. **Action Risk Escalation**: `rm -rf` on non-temp files should trigger HIGH-RISK gate
3. **Intent Verification**: Destructive actions on recently-recovered data require confirmation
4. **Post-Error Safe Mode**: After misidentifying files once, elevate all action thresholds

## Defense Layers

```
Layer 1: Pattern Matching (guard.py)
         ↓ bypass attempts
Layer 2: Path Protection (paths.py)
         ↓ file writes
Layer 3: Sliding Window + Lock (violations.py)
         ↓ repeated violations
Layer 4: Integrity Chain (violations.py)
         ↓ tampering detection
Layer 5: Human Authorization (--confirm gate)
         ↓ unlock attempts
```

## Current Coverage

| Attack Type | Detection | Bypass Resistance |
|------------|-----------|-------------------|
| Direct dangerous Bash | 73% | Low (base64, variable, eval bypass) |
| Git destruction | 87% | Medium |
| Filesystem boundary | 85% | N/A (path-based) |
| Self-protect | Runtime-only | High (integrity chain) |
| Semantic misunderstanding | 0% | Not covered |

## Roadmap

- [ ] Multi-step attack chain detection
- [ ] Asset classification for temp-file safety
- [ ] ML-based command intent analysis
- [ ] Cross-agent configuration protection
- [ ] Post-error safe mode (auto-elevate thresholds after mistakes)
