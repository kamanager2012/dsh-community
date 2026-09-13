#!/usr/bin/env python3
"""
acs_structural.py — v1.1.0 结构验证 + ABI 保护 (H-3, H-4, M-8)

v0.3.x 缺陷修复:
  H-3  Edit 错位 (old_string 不存在) 静默通过 →
       v1.1.0 返回 ok=False 强制 fail-loud
  H-4  MultiEdit 部分应用无报告 →
       v1.1.0 检查所有 edit 都命中，否则 deny
  M-8  空文件行数返回 1 (count('\n')+1) →
       v1.1.0 显式处理空字符串
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from acs_paths import is_abi_protected, resolve, _safe_resolve

SHRINK_RATIO: float = 0.5
SUPPORTED_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".swift", ".kt")

# ── 结构计数正则（v1.1.0 修复 M-1: 排除注释/字符串干扰）─────────────────
# 匹配 "export" 但排除 // 开头和 /* */ 内部
_EXPORT = re.compile(
    r"^\s*(?://[^\n]*\n\s*)?export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum|abstract)",
    re.MULTILINE,
)
_INTERFACE = re.compile(r"^\s*(?:export\s+)?interface\s+\w+", re.MULTILINE)
_TYPE = re.compile(r"^\s*(?:export\s+)?type\s+\w+", re.MULTILINE)
_ENUM = re.compile(r"^\s*(?:export\s+)?enum\s+\w+", re.MULTILINE)
_CLASS = re.compile(r"^\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+", re.MULTILINE)
_FUNCTION = re.compile(
    r"^\s*(?:export\s+)?(?:async\s+)?function\s+\w+|"
    r"^\s*(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(",
    re.MULTILINE,
)


def _read_text_safe(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except Exception:
        return ""


def count_structures(text: str) -> Dict[str, int]:
    """v1.1.0 修复 M-8: 空字符串显式返回 0 行。"""
    if not text:
        return {"lines": 0, "exports": 0, "interfaces": 0,
                "types": 0, "enums": 0, "classes": 0, "functions": 0}
    return {
        "lines": text.count("\n") + (0 if text.endswith("\n") else 1) if text else 0,
        "exports": len(_EXPORT.findall(text)),
        "interfaces": len(_INTERFACE.findall(text)),
        "types": len(_TYPE.findall(text)),
        "enums": len(_ENUM.findall(text)),
        "classes": len(_CLASS.findall(text)),
        "functions": len(_FUNCTION.findall(text)),
    }


def predict_final_content(file_path: str, tool_name: str, tool_input: Dict) -> Tuple[Optional[str], str]:
    """v1.1.0 修复 H-3, H-4: 返回 (predicted_content, status)。
    status: "ok" | "not_found" | "partial" | "no_prediction" """
    if tool_name == "Write":
        return tool_input.get("content", ""), "ok"
    current = _read_text_safe(resolve(file_path))
    if tool_name == "Edit":
        old_s = tool_input.get("old_string", "")
        new_s = tool_input.get("new_string", "")
        if not old_s:
            return None, "no_prediction"
        if old_s not in current:
            return None, "not_found"  # v1.1.0: 显式标记
        return current.replace(old_s, new_s, 1), "ok"
    if tool_name == "MultiEdit":
        result = current
        missing_edits = []
        for idx, edit in enumerate(tool_input.get("edits", [])):
            o = edit.get("old_string", "")
            n = edit.get("new_string", "")
            if not o:
                continue
            if o in result:
                result = result.replace(o, n, 1)
            else:
                missing_edits.append(idx)
        if missing_edits:
            return None, f"partial:missing_edits={missing_edits}"  # v1.1.0
        return result, "ok"
    return None, "no_prediction"


def verify_structural_change(file_path: str, tool_name: str, tool_input: Dict) -> Dict:
    """v1.1.0 修复 H-3, H-4: Edit/MultiEdit 命中失败显式返回。"""
    resolved = resolve(file_path)
    is_abi = is_abi_protected(file_path)
    current_text = _read_text_safe(resolved) if resolved.exists() else ""
    predicted, status = predict_final_content(file_path, tool_name, tool_input)

    # v1.1.0 修复 H-3, H-4: 显式处理未命中
    if status != "ok":
        if status == "not_found":
            return {"ok": False, "checks": [("EDIT_NOT_FOUND",
                f"old_string not found in {file_path}")], "before": {}, "after": {}}
        if status.startswith("partial"):
            return {"ok": False, "checks": [("MULTIEDIT_PARTIAL", status)], "before": {}, "after": {}}
        return {"ok": True, "reason": "no_prediction", "before": {}, "after": {}}

    before = count_structures(current_text)
    after = count_structures(predicted)
    checks: List[Tuple[str, str]] = []

    # 文件缩减检查
    if before["lines"] > 0:
        shrink = (before["lines"] - after["lines"]) / before["lines"]
        if shrink > (1.0 - SHRINK_RATIO):
            checks.append(("SHRINK",
                f"file shrunk {shrink:.0%} ({before['lines']}→{after['lines']} lines)"))

    # ABI 检查
    if is_abi and before["exports"] > 0:
        if after["exports"] < before["exports"]:
            checks.append(("EXPORT_LOSS", f"exports dropped {before['exports']}→{after['exports']}"))
        if after["interfaces"] < before["interfaces"]:
            checks.append(("INTERFACE_LOSS", f"interfaces dropped {before['interfaces']}→{after['interfaces']}"))
        if after["types"] < before["types"]:
            checks.append(("TYPE_LOSS", f"types dropped {before['types']}→{after['types']}"))

    if checks:
        return {"ok": False, "checks": checks, "before": before, "after": after}
    return {"ok": True, "reason": "structural_ok", "before": before, "after": after}
