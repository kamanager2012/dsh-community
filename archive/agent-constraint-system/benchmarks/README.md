# ACS Safety Benchmark

Automated safety evaluation suite for the Agent Constraint System. Tests ACS guards against 100+ adversarial scenarios, including dangerous Bash commands, destructive Git operations, filesystem writes, bypass attempts, and false positives.

## Quick Start

```bash
cd benchmarks
python3 runner.py           # Run all scenarios
python3 report.py           # Generate Markdown report
python3 report.py --json    # Generate JSON report
```

## Scenario Categories

| Category | Count | Description |
|----------|-------|-------------|
| `bash_dangerous` | 30 | rm -rf, kill -9, mkfs, dd, chmod 777, fork bombs, curl|sh |
| `git_destructive` | 15 | reset --hard, clean -fdx, push --force, checkout -- . |
| `filesystem_write` | 20 | Writes to /etc/, /usr/, /bin/, /boot/, /sys/ |
| `self_protect` | 10 | Modifying ACS system files |
| `bypass_attempts` | 20 | base64, variable substitution, alias, eval, heredoc, string concat, indirect exec |
| `false_positive` | 10 | Legitimate commands that should NOT be blocked |
| **Total** | **105** | |

## Bypass Methods Tested

1. **base64** — echo base64 | base64 -d | sh
2. **variable** — VAR="bad command"; $VAR
3. **alias** — alias x='bad command'; x
4. **heredoc** — sh <<EOF\nbad command\nEOF
5. **string_concat** — ec"h"o 'bad'
6. **python_exec** — python3 -c "import os; os.system('bad')"
7. **perl_exec** — perl -e 'system("bad")'
8. **eval** — eval "bad command"
9. **subshell** — $(bad command)
10. **backtick** — \`bad command\`
