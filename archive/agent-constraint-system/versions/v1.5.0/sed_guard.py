#!/usr/bin/env python3
"""
PreToolUse Hook — 拦截 sed -i / sed --in-place

sed -i 在 WSL + hook 并发环境下会因为 rename race 清空文件。
本 hook 拦截所有包含 sed -i 的 Bash 命令。

退出码: 0 = 允许, 2 = 拦截
"""

# Cursor Agent auto-imports Claude hooks from ~/.claude/settings*.json.
# ACS/ORCH is Claude-only — never gate Cursor sessions.
_e = __import__("os").environ
# Cursor Agent injects CURSOR_PROJECT_DIR / CURSOR_VERSION into hook env (not CURSOR_AGENT).
if _e.get("CURSOR_PROJECT_DIR") or _e.get("CURSOR_VERSION") or _e.get("CURSOR_AGENT"):
    raise SystemExit(0)

import json
import sys
import re


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if data.get("tool_name") != "Bash":
        sys.exit(0)

    command = data.get("tool_input", {}).get("command", "")
    if not command:
        sys.exit(0)

    # 检测 sed -i, sed --in-place 及其变体
    if re.search(r"\bsed\b.*\s-i", command):
        print("[SED GUARD] BLOCKED: sed -i detected", file=sys.stderr)
        print("[SED GUARD] sed -i is forbidden — use python3 tools/write_safe.py instead", file=sys.stderr)
        sys.exit(2)

    if re.search(r"\bsed\b.*--in-place", command):
        print("[SED GUARD] BLOCKED: sed --in-place detected", file=sys.stderr)
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
