#!/usr/bin/env python3
"""
abi_guard.py — PostToolUse Hook
检测 ABI 漂移：export 删除、interface 字段减少、类型降级为 any。

工作流程：
1. 读取 abi-lock.json 中的锁定状态
2. 对比修改前后的 export/interface 变化
3. 发现破坏性变更 → 记录到审计日志 + 警告

注意：这个 hook 是检测性的（PostToolUse），真正的阻止需要 PreToolUse hook
配合 verifier 使用。

exit 0 = pass, exit 2 = abi violation detected
"""

# Cursor Agent auto-imports Claude hooks from ~/.claude/settings*.json.
# ACS/ORCH is Claude-only — never gate Cursor sessions.
_e = __import__("os").environ
# Cursor Agent injects CURSOR_PROJECT_DIR / CURSOR_VERSION into hook env (not CURSOR_AGENT).
if _e.get("CURSOR_PROJECT_DIR") or _e.get("CURSOR_VERSION") or _e.get("CURSOR_AGENT"):
    raise SystemExit(0)

import ast
import json
import os
import sys
import time
from pathlib import Path

CWD = Path(os.environ.get("CLAUDE_CWD", os.getcwd())).resolve()
ABI_LOCK = CWD / ".claude" / "governance" / "abi-lock.json"
AUDIT_LOG = CWD / ".claude" / "audit" / "abi-violations.jsonl"


def _rel(path_str: str) -> str:
    p = Path(path_str)
    if not p.is_absolute():
        p = CWD / p
    try:
        return str(p.resolve().relative_to(CWD))
    except ValueError:
        return str(p.resolve())


def _is_source_file(path_str: str) -> bool:
    """只检查 TypeScript/JavaScript 源码"""
    return path_str.endswith((".ts", ".tsx", ".js", ".jsx"))


def _extract_exports(source: str) -> dict:
    """
    简单提取 export 的函数/类/类型名称。
    用正则做轻量解析（不做完整 AST，避免依赖）。
    """
    import re
    exports = {}
    # export function/class/const/type/interface/enum
    patterns = [
        r'export\s+(?:default\s+)?(?:function|class|const|type|interface|enum)\s+(\w+)',
        r'export\s+\{([^}]+)\}',  # export { A, B, C }
    ]
    for pat in patterns:
        for m in re.finditer(pat, source):
            name = m.group(1).strip()
            if name and name not in ("from", "default"):
                exports[name] = {
                    "line": source[:m.start()].count("\n") + 1,
                    "kind": "named",
                }
    return exports


def _extract_interfaces(source: str) -> dict:
    """提取 interface 定义及其字段"""
    import re
    interfaces = {}
    for m in re.finditer(r'export\s+interface\s+(\w+)\s*\{([^}]*)\}', source, re.DOTALL):
        name = m.group(1)
        body = m.group(2)
        # 提取字段名
        fields = []
        for fm in re.finditer(r'(\w+)\s*[?!]:', body):
            fields.append(fm.group(1))
        interfaces[name] = fields
    return interfaces


def _detect_any_pollution(old_source: str, new_source: str) -> list:
    """检测是否新增了 any 类型"""
    import re
    violations = []
    # 简单检测：新文件中 `any` 关键词增加
    old_count = len(re.findall(r'\bany\b', old_source))
    new_count = len(re.findall(r'\bany\b', new_source))
    if new_count > old_count:
        violations.append(f"any 类型增加: {old_count} → {new_count}")
    return violations


def _check_abi(file_path: str, old_content: str, new_content: str) -> list:
    """检查 ABI 变化，返回违规列表"""
    violations = []

    old_exports = _extract_exports(old_content)
    new_exports = _extract_exports(new_content)

    # 检测 export 删除
    for name in old_exports:
        if name not in new_exports:
            violations.append(f"export 删除: {name}")

    # 检测 interface 字段变化
    old_interfaces = _extract_interfaces(old_content)
    new_interfaces = _extract_interfaces(new_content)
    for name, old_fields in old_interfaces.items():
        if name in new_interfaces:
            new_fields = new_interfaces[name]
            removed = set(old_fields) - set(new_fields)
            if removed:
                violations.append(f"interface {name} 字段删除: {removed}")

    # 检测 any 污染
    violations.extend(_detect_any_pollution(old_content, new_content))

    return violations


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    # 只在 Write/Edit 后检查
    tool = data.get("tool_name", "")
    if tool not in ("Write", "Edit"):
        sys.exit(0)

    inp = data.get("tool_input", {})
    file_path = inp.get("file_path", "")

    # 只检查源码文件
    if not _is_source_file(file_path):
        sys.exit(0)

    # 读取旧内容（如果文件存在）
    resolved = Path(file_path) if Path(file_path).is_absolute() else CWD / file_path
    old_content = ""
    if resolved.exists() and tool == "Edit":
        try:
            old_content = resolved.read_text(encoding="utf-8")
        except Exception:
            pass

    # 新内容
    new_content = inp.get("content", "")
    if not new_content and tool == "Edit":
        # Edit 工具没有 content 字段，跳过
        sys.exit(0)

    if not old_content or not new_content:
        sys.exit(0)

    violations = _check_abi(file_path, old_content, new_content)

    if violations:
        rel = _rel(file_path)
        print(f"[ABI GUARD] 检测到 {len(violations)} 个 ABI 违规: {rel}", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)

        # 记录审计
        try:
            os.makedirs(AUDIT_LOG.parent, exist_ok=True)
            with open(AUDIT_LOG, "a", encoding="utf-8") as f:
                json.dump({
                    "timestamp": time.time(),
                    "file": rel,
                    "violations": violations,
                }, f)
                f.write("\n")
        except Exception:
            pass

        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
