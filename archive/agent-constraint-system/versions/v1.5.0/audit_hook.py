#!/usr/bin/env python3
"""
audit_hook.py — PostToolUse Hook
记录所有工具调用到 append-only 审计日志。

日志格式：JSON Lines (.jsonl)
每条记录包含：时间戳、工具名、目标文件/命令、操作类型

这个 hook 不做任何拦截，纯记录。
审计日志是 AIOS 治理的基础——没有它就没有 replay/rollback/追责。
"""

import json
import os
import sys
import time
from pathlib import Path

CWD = Path(os.environ.get("CLAUDE_CWD", os.getcwd())).resolve()
AUDIT_LOG = CWD / ".claude" / "audit" / "tool-audit.jsonl"

# 记录这些工具的其他信息
FILE_TOOLS = {"Write", "Edit", "Read"}
SHELL_TOOLS = {"Bash"}


def _rel(path_str: str) -> str:
    if not path_str:
        return ""
    p = Path(path_str)
    if not p.is_absolute():
        p = CWD / p
    try:
        return str(p.resolve().relative_to(CWD))
    except ValueError:
        return str(p.resolve())


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool = data.get("tool_name", "")
    inp = data.get("tool_input", {})

    record = {
        "timestamp": time.time(),
        "tool": tool,
        "action": "use",
    }

    if tool in FILE_TOOLS:
        record["file"] = _rel(inp.get("file_path", ""))
        if tool == "Write":
            content = inp.get("content", "")
            record["content_size"] = len(content) if content else 0
        elif tool == "Edit":
            record["old_string_len"] = len(inp.get("old_string", ""))
    elif tool in SHELL_TOOLS:
        cmd = inp.get("command", "")
        record["command"] = cmd[:500]  # 截断防止日志膨胀
        # 标记危险等级
        dangerous = ["rm -rf", "rm -f", "kill -9", "mkfs", "dd if=", "chmod 777"]
        record["risk"] = "HIGH" if any(d in cmd for d in dangerous) else "LOW"

    # 写入 append-only 日志 (v0.3.x: 自动轮换, 保留最近 1000 条)
    try:
        os.makedirs(AUDIT_LOG.parent, exist_ok=True)
        current_lines = len(open(AUDIT_LOG).readlines()) if os.path.exists(AUDIT_LOG) else 0
        if current_lines > 1000:
            keep = open(AUDIT_LOG).readlines()[-1000:]
            with open(AUDIT_LOG, 'w') as rf:
                rf.writelines(keep)
        with open(AUDIT_LOG, "a", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False)
            f.write("\n")
    except Exception:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
