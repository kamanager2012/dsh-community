#!/usr/bin/env python3
"""
guard.py v1.2.0 — PreToolUse Hook: block destructive bash commands without explicit confirmation.

v1.1.0: Strategy: extract the first real command token (the executable), and check
only direct arguments after it. Ignore everything inside quotes/heredocs.
This prevents false positives like `python3 -c "echo kill -9 is bad"`.

v1.2.0 P2-6: rm -rf 对常规目录名不再误触发。
只有 /, /*, ~, * 这类 root/home/wildcard 目标才拦截。

exit 0 = allow, exit 2 = block
"""

# Cursor Agent auto-imports Claude hooks from ~/.claude/settings*.json.
# ACS/ORCH is Claude-only — never gate Cursor sessions.
_e = __import__("os").environ
# Cursor Agent injects CURSOR_PROJECT_DIR / CURSOR_VERSION into hook env (not CURSOR_AGENT).
if _e.get("CURSOR_PROJECT_DIR") or _e.get("CURSOR_VERSION") or _e.get("CURSOR_AGENT"):
    raise SystemExit(0)

import json
import re
import shlex
import sys

# Block patterns: (regex, description)
# These match the cleaned command (quotes/heredocs stripped)
DANGEROUS = [
    # rm -rf /, rm -rf /*, rm -rf ~, rm -rf *
    # v1.2.0 P2-6: Only block when target is root(/), home(~), or wildcard(*)
    # Regular named directories like /tmp/build, /home/user/project are NOT blocked
    # Pattern: rm with -f flag followed by bare / or ~ or * as standalone arg
    (r'(?:^|[|;]\s*)rm\s+(?:-[a-z]*f[a-z]*\s+)+(?:/$(?:\s|$)|/\*\s|~(?:\s|$)|\*(?:\s|$))',
     "rm -rf targeting root/home/wildcard"),
    # kill -9
    (r'(?:^|[|;]\s*)kill\s+-9\b', "kill -9 (force kill)"),
    # mkfs
    (r'(?:^|[|;]\s*)mkfs\.', "mkfs (disk format)"),
    # dd if=/dev/
    (r'(?:^|[|;]\s*)dd\s+if=/dev/', "dd writing to block device"),
]

COMPILED = [(re.compile(p, re.IGNORECASE), desc) for p, desc in DANGEROUS]


def _clean_command(cmd: str) -> str:
    """
    Remove content inside single quotes, double quotes, and heredocs.
    This prevents matching keywords inside string literals.
    """
    result = cmd
    # Remove single-quoted strings
    result = re.sub(r"'[^']*'", "''", result)
    # Remove double-quoted strings (handle escaped quotes)
    result = re.sub(r'"[^"\\]*(?:\\.[^"\\]*)*"', '""', result)
    # Remove heredoc bodies (<< 'EOF' ... EOF)
    result = re.sub(
        r'<<\s*["\']?(\w+)["\']?\s*\n.*?\n\s*\1',
        '<<HEREDOC>>',
        result,
        flags=re.DOTALL,
    )
    return result


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, Exception):
        sys.exit(0)

    cmd = data.get("tool_input", {}).get("command", "")
    if not cmd:
        sys.exit(0)

    # Clean: strip quoted content
    cmd_clean = _clean_command(cmd)

    for pattern, desc in COMPILED:
        if pattern.search(cmd_clean):
            print(f"[GUARD BLOCKED] {desc}", file=sys.stderr)
            print(f"[GUARD BLOCKED] Command: {cmd[:200]}", file=sys.stderr)
            print("[GUARD] This operation requires explicit user confirmation.", file=sys.stderr)
            sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()