#!/usr/bin/env python3
"""
proposal_guard.py — v1.2.0 PostToolUse Hook (P0-1/P0-3 修复)

v1.1.0 问题:
  - 注册在 PreToolUse 但代码是 PostToolUse 语义 → 控制流错位
  - 白名单是 closed-world (枚举路径前缀) → 正常路径被误判
  - path traversal 风险 (../../etc/ 可绕过前缀匹配)

v1.2.0 修复:
  - 移至 PostToolUse（纯审计，exit 0 不拦截）
  - acs_lite.py 是唯一 PreToolUse 决策中心（含 proposal gate）
  - 白名单改为 open-world: prefix-based + is_relative_to 防遍历
  - 加 safety assert: 不逃出 HOME, scope 必须存在

exit 0 = allow (PostToolUse 永远 allow, 只记录审计)
"""

# Cursor Agent auto-imports Claude hooks from ~/.claude/settings*.json.
# ACS/ORCH is Claude-only — never gate Cursor sessions.
_e = __import__("os").environ
# Cursor Agent injects CURSOR_PROJECT_DIR / CURSOR_VERSION into hook env (not CURSOR_AGENT).
if _e.get("CURSOR_PROJECT_DIR") or _e.get("CURSOR_VERSION") or _e.get("CURSOR_AGENT"):
    raise SystemExit(0)

import json
import os
import sys
import time
from pathlib import Path

HOME = Path.home().resolve()
CWD = Path(os.environ.get("CLAUDE_CWD", os.getcwd())).resolve()
PROPOSAL_LOG = CWD / ".claude" / "audit" / "proposals.jsonl"

# v1.2.0 P0-3: open-world allowed paths (prefix-based, is_relative_to 防遍历)
ALLOWED_PREFIXES: list[Path] = [
    HOME / ".claude" / "runtime",
    HOME / ".claude" / "audit",
    HOME / ".claude" / "snapshots",
    HOME / ".claude" / "governance",
    HOME / ".claude" / "hooks",           # ACS 自身
    HOME / "agent-constraint-system",      # ACS 项目文档
    HOME / "my-project",                   # 项目代码
    Path("/tmp/claude-shadow"),
    Path("/tmp"),
]


def _is_allowed_path(file_path: str) -> bool:
    """Open-world 白名单: prefix-based + is_relative_to 防遍历。

    v1.1.0 Bug: closed-world 枚举前缀 → 新路径被误判
    v1.2.0 Fix:  用 is_relative_to 替代 startswith, 阻止 /tmp/../../etc/ 绕过
    """
    try:
        resolved = Path(file_path).resolve()
    except (OSError, ValueError):
        return False

    # Safety assert: 路径不逃出 HOME（/tmp 例外）
    if not (resolved.is_relative_to(HOME) or resolved.is_relative_to(Path("/tmp"))):
        return False

    for prefix in ALLOWED_PREFIXES:
        try:
            if resolved == prefix or resolved.is_relative_to(prefix):
                return True
        except (OSError, ValueError):
            continue
    return False


def _needs_proposal(file_path: str) -> bool:
    """v1.2.0: 不在白名单 → 需要 proposal（但 PostToolUse 只警告不拦截）。"""
    return not _is_allowed_path(file_path)


def _has_proposal(file_path: str) -> bool:
    """检查审计日志中是否有最近的 Proposal 记录"""
    if not PROPOSAL_LOG.exists():
        return False
    resolved = Path(file_path).resolve()
    try:
        rel = str(resolved.relative_to(CWD))
    except ValueError:
        rel = str(resolved)
    try:
        lines = PROPOSAL_LOG.read_text(encoding="utf-8").strip().split("\n")
        for line in reversed(lines[-50:]):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
                if record.get("target") == rel and record.get("status") == "approved":
                    ts = record.get("approved_at", 0)
                    if time.time() - ts < 1800:
                        return True
            except json.JSONDecodeError:
                continue
    except Exception:
        pass
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool = data.get("tool_name", "")
    if tool not in ("Write", "Edit"):
        sys.exit(0)

    inp = data.get("tool_input", {})
    file_path = inp.get("file_path", "")
    if not file_path:
        sys.exit(0)

    # 白名单路径不需要 Proposal
    if not _needs_proposal(file_path):
        sys.exit(0)

    # 有有效 Proposal → 无需警告
    if _has_proposal(file_path):
        sys.exit(0)

    # v1.2.0: PostToolUse 纯审计 — 不拦截，只记录
    print(f"[PROPOSAL GUARD] 写文件未检测到 Proposal: {file_path}", file=sys.stderr)

    # 记录违规审计
    audit_path = CWD / ".claude" / "audit" / "proposal-violations.jsonl"
    try:
        os.makedirs(audit_path.parent, exist_ok=True)
        resolved = Path(file_path).resolve()
        try:
            rel = str(resolved.relative_to(CWD))
        except ValueError:
            rel = str(resolved)
        with open(audit_path, "a", encoding="utf-8") as f:
            json.dump({
                "timestamp": time.time(),
                "tool": tool,
                "file": rel,
                "error": "missing_proposal",
                "version": "4.2",
            }, f)
            f.write("\n")
    except Exception:
        pass

    # PostToolUse 永远 allow (exit 0)
    sys.exit(0)


if __name__ == "__main__":
    main()