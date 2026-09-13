#!/usr/bin/env python3
"""
authority_invariant.py — Authority Invariant Scanner (v1.0)
保护 Trust Boundary 不被 AI 语义掏空。

目标函数: verify*, authorize*, check*, validate*, assert*, guard*, require*
           + permission, capability, access, auth, role, scope 相关

检测模式:
  CRITICAL: return true (无拒绝路径) / empty body / 无 deny path
  HIGH:     catch {} 吞异常 / TODO/FIXME bypass / DEBUG bypass / removed throw
  MEDIUM:   catch → log only / unconditional allow / 降级拒绝为警告

用法:
  python3 authority_invariant.py scan [--root <dir>]      # 扫描 + 报告
  python3 authority_invariant.py diff [--root <dir>]      # 对比上次快照
  python3 authority_invariant.py lock [--root <dir>]      # 锁定当前为基线
"""

# Cursor Agent auto-imports Claude hooks from ~/.claude/settings*.json.
# ACS/ORCH is Claude-only — never gate Cursor sessions.
_e = __import__("os").environ
# Cursor Agent injects CURSOR_PROJECT_DIR / CURSOR_VERSION into hook env (not CURSOR_AGENT).
if _e.get("CURSOR_PROJECT_DIR") or _e.get("CURSOR_VERSION") or _e.get("CURSOR_AGENT"):
    raise SystemExit(0)

import hashlib
import json
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

# ============================================================
# 配置
# ============================================================
CWD = Path(os.environ.get("CLAUDE_CWD", os.getcwd())).resolve()
DEFAULT_ROOT = CWD / "my-project" / "projects" / "gaokao" / "frontend" / "src"
SNAPSHOT_FILE = CWD / ".claude" / "governance" / "authority-snapshot.json"

EXCLUDE_DIRS = {"node_modules", "__tests__", "dist", ".git", "archive", "v6", "v7", "v8", "v9"}
EXTENSIONS = {".ts", ".tsx"}

# Authority 函数命名模式
AUTHORITY_PATTERNS = [
    # 函数名以 authority 前缀开头
    r'\b(function|const|let|var|=>)\s+(verify|authorize|check|validate|assert|guard|require|ensure)\w*\s*[=<(]',
    r'\b(async\s+function\s+)?(verify|authorize|check|validate|assert|guard|require|ensure)\w*\s*\(',
    # 特定的能力检查命名模式
    r'\b(?:can|has|is|should|may|must)(?:Access|Permission|Role|Capability|Auth|Scope|Admin|Owner|Allowed)\w*\s*\(',
    # 以 Permission/Capability/Auth 结尾的函数
    r'\b\w+(?:Permission|Capability|Authorization|Authentication)\s*\(',
]

# 危险模式: (pattern, severity, description, risk_score)
DANGEROUS_PATTERNS = [
    # CRITICAL — 直接放行
    (r'^\s*return\s+true\s*;?\s*$', "CRITICAL", "无条件返回 true — 直接放行所有请求", 100),
    (r'^\s*return\s+null\s*;?\s*$', "CRITICAL", "空返回 — 缺少验证逻辑", 80),
    # empty body
    (r'^\s*\{\s*\}\s*$', "CRITICAL", "空函数体 — 无任何验证", 100),

    # HIGH — 旁路
    (r'^\s*return\s*;\s*$', "HIGH", "无返回值 — 缺少显式拒绝", 60),
    (r'\bTODO\b.*\b(?:bypass|skip|disable|remove)\b', "HIGH", "TODO/BYPASS 注释 — 计划移除验证", 50),
    (r'\bFIXME\b.*\b(?:bypass|skip|hack|temp)\b', "HIGH", "FIXME 旁路 — 临时绕过验证", 50),
    (r'\bDEBUG\b.*return\s+true', "HIGH", "DEBUG 模式直接放行 — 可能留在生产代码", 70),
    (r'process\.env\.\w+\s*===\s*[\'"]development[\'"]', "HIGH", "开发环境旁路 — 验证在生产环境可能被屏蔽", 40),

    # MEDIUM — 降级
    (r'catch\s*\{[^}]*\}', "MEDIUM", "空 catch — 异常被完全吞没", 30),
    (r'catch\s*\([^)]*\)\s*\{[^}]*console\.(?:warn|log|error)\s*\([^)]*\)[^}]*\}', "MEDIUM", "catch → log only — 拒绝被降级为日志", 30),
    (r'return\s+Promise\.resolve\(true\)', "MEDIUM", "Promise.resolve(true) — 异步直接放行", 40),
]

# 拒绝路径关键词
DENY_PATH_PATTERNS = [
    r'\bthrow\b',
    r'\breturn\s+false\b',
    r'\breject\s*\(',
    r'\bdeny\s*\(',
    r'\bforbid\s*\(',
    r'\bunauthorized\b',
    r'\bforbidden\b',
    r'\baccess\s*denied\b',
    r'\bpermission\s*denied\b',
]

# ============================================================
# 解析器
# ============================================================

def _find_authority_functions(source: str) -> list:
    """发现所有 Authority 函数"""
    found = []
    for pattern in AUTHORITY_PATTERNS:
        for m in re.finditer(pattern, source, re.IGNORECASE):
            name = m.group(0).rstrip("(").strip()
            # 跳过非函数上下文
            before = source[max(0, m.start() - 50):m.start()]
            if "import" in before or "from" in before.split("\n")[-1]:
                continue
            found.append({
                "name": name,
                "line": source[:m.start()].count("\n") + 1,
                "position": m.start(),
            })
    # 去重
    seen = set()
    unique = []
    for f in found:
        key = (f["name"], f["line"])
        if key not in seen:
            seen.add(key)
            unique.append(f)
    return unique


def _extract_function_body(source: str, start_pos: int) -> tuple:
    """从函数声明位置提取函数体"""
    remainder = source[start_pos:]
    # 找到第一个 { 的位置
    brace_pos = remainder.find("{")
    if brace_pos < 0 or brace_pos > 200:
        return "", start_pos + len(remainder)

    # 从 { 开始做括号匹配
    depth = 0
    body_start = start_pos + brace_pos
    end_pos = body_start
    for i, ch in enumerate(source[body_start:], body_start):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end_pos = i + 1
                break

    # 截取函数体（不包括外层 { }）
    body = source[body_start + 1:end_pos - 1]
    return body, end_pos


def _check_dangerous_patterns(body: str) -> list:
    """检查函数体中的危险模式"""
    violations = []
    lines = body.split("\n")

    for pattern, severity, desc, score in DANGEROUS_PATTERNS:
        if re.search(pattern, body, re.MULTILINE | re.IGNORECASE):
            line_num = 0
            for m in re.finditer(pattern, body, re.MULTILINE | re.IGNORECASE):
                line_num = body[:m.start()].count("\n") + 1
                break
            violations.append({
                "pattern": pattern,
                "severity": severity,
                "description": desc,
                "risk_score": score,
                "line_offset": line_num,
            })

    return violations


def _has_deny_path(body: str) -> tuple:
    """检查函数体是否仍有拒绝路径"""
    found = []
    for pattern in DENY_PATH_PATTERNS:
        for m in re.finditer(pattern, body, re.IGNORECASE):
            line = body[:m.start()].count("\n") + 1
            found.append({"pattern": pattern, "match": m.group(0)[:40], "line": line})

    return bool(found), found


def _extract_semantic_fingerprint(body: str) -> dict:
    """提取语义指纹"""
    return {
        "lines": body.count("\n") + 1,
        "conditional_count": len(re.findall(r'\bif\b', body)),
        "throw_count": len(re.findall(r'\bthrow\b', body)),
        "return_false_count": len(re.findall(r'\breturn\s+false\b', body)),
        "reject_count": len(re.findall(r'\breject\s*\(', body)),
        "try_count": len(re.findall(r'\btry\b', body)),
        "catch_count": len(re.findall(r'\bcatch\b', body)),
        "early_return_count": len(re.findall(r'\breturn\s+(?!true\b)', body)),
    }


# ============================================================
# 扫描器
# ============================================================

def scan(root: Path) -> dict:
    """全量扫描"""
    results = {
        "scanned_at": time.time(),
        "root": str(root),
        "authority_functions": [],
        "violations": [],
        "summary": {"total_authority": 0, "critical": 0, "high": 0, "medium": 0, "files": 0},
    }

    files_scanned = 0

    for f in sorted(root.rglob("*")):
        if f.suffix not in EXTENSIONS:
            continue
        if any(part in EXCLUDE_DIRS for part in f.parts):
            continue
        try:
            source = f.read_text(encoding="utf-8")
        except Exception:
            continue

        rel = str(f.relative_to(root))
        authority_funcs = _find_authority_functions(source)

        if not authority_funcs:
            continue

        files_scanned += 1

        for func in authority_funcs:
            body, end_pos = _extract_function_body(source, func["position"])
            if not body:
                continue

            dangerous = _check_dangerous_patterns(body)
            has_deny, deny_matches = _has_deny_path(body)
            fingerprint = _extract_semantic_fingerprint(body)

            # 判定最高严重度
            max_severity = "OK"
            risk = 0
            if dangerous:
                severities = {"CRITICAL": 3, "HIGH": 2, "MEDIUM": 1}
                max_sev = max(dangerous, key=lambda d: severities.get(d["severity"], 0))
                max_severity = max_sev["severity"]
                risk = sum(d["risk_score"] for d in dangerous)

            # 无拒绝路径 = 升级
            if not has_deny and fingerprint["lines"] > 1:
                if max_severity == "OK":
                    max_severity = "HIGH"
                    risk = max(risk, 70)
                dangerous.append({
                    "pattern": "no_deny_path",
                    "severity": "CRITICAL" if fingerprint["conditional_count"] == 0 else "HIGH",
                    "description": f"无拒绝路径: 缺少 throw/return false/reject/deny",
                    "risk_score": 100 if fingerprint["conditional_count"] == 0 else 70,
                    "line_offset": 1,
                })

            entry = {
                "file": rel,
                "function": func["name"],
                "line": func["line"],
                "severity": max_severity,
                "risk_score": risk,
                "dangerous_patterns": dangerous,
                "has_deny_path": has_deny,
                "deny_matches": deny_matches[:5],
                "fingerprint": fingerprint,
            }

            results["authority_functions"].append(entry)
            if max_severity != "OK":
                results["violations"].append(entry)
                results["summary"][max_severity.lower()] += 1

    results["summary"]["total_authority"] = len(results["authority_functions"])
    results["summary"]["files"] = files_scanned

    return results


# ============================================================
# 命令
# ============================================================

def cmd_scan(root: Path):
    data = scan(root)
    print(json.dumps(data, indent=2, ensure_ascii=False, default=str))
    s = data["summary"]
    print(f"\n[AUTHORITY INVARIANT] {s['total_authority']} authority functions in {s['files']} files",
          file=sys.stderr)
    print(f"[AUTHORITY INVARIANT] CRIT:{s['critical']} HIGH:{s['high']} MED:{s['medium']}",
          file=sys.stderr)


def cmd_lock(root: Path):
    data = scan(root)
    os.makedirs(SNAPSHOT_FILE.parent, exist_ok=True)
    with open(SNAPSHOT_FILE, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False, default=str)
    s = data["summary"]
    print(f"[AUTHORITY INVARIANT] Locked: {s['total_authority']} functions → {SNAPSHOT_FILE}",
          file=sys.stderr)
    print(f"[AUTHORITY INVARIANT] CRIT:{s['critical']} HIGH:{s['high']} MED:{s['medium']}",
          file=sys.stderr)


def cmd_diff(root: Path):
    if not SNAPSHOT_FILE.exists():
        print("[AUTHORITY INVARIANT] No baseline. Run 'lock' first.", file=sys.stderr)
        sys.exit(1)

    old = json.load(open(SNAPSHOT_FILE))
    new = scan(root)

    old_funcs = {(f["file"], f["function"]) for f in old["authority_functions"]}
    new_funcs = {(f["file"], f["function"]) for f in new["authority_functions"]}

    added = new_funcs - old_funcs
    removed = old_funcs - new_funcs
    changed = []

    old_map = {(f["file"], f["function"]): f for f in old["authority_functions"]}
    new_map = {(f["file"], f["function"]): f for f in new["authority_functions"]}

    for key in old_funcs & new_funcs:
        of = old_map[key]
        nf = new_map[key]
        fp_old = of["fingerprint"]
        fp_new = nf["fingerprint"]
        diffs = {}
        for k in fp_old:
            if fp_old[k] != fp_new.get(k, fp_old[k]):
                diffs[k] = {"old": fp_old[k], "new": fp_new.get(k, fp_old[k])}
        if diffs:
            changed.append({
                "file": nf["file"],
                "function": nf["function"],
                "old_severity": of["severity"],
                "new_severity": nf["severity"],
                "fingerprint_changes": diffs,
            })

    # Guard removal detection
    guard_removals = []
    for key in old_funcs & new_funcs:
        of = old_map[key]
        nf = new_map[key]
        fp_new = nf["fingerprint"]
        fp_old = of["fingerprint"]
        if fp_old["throw_count"] > fp_new["throw_count"]:
            guard_removals.append({
                "file": nf["file"],
                "function": nf["function"],
                "throw_count_change": fp_old["throw_count"] - fp_new["throw_count"],
                "return_false_change": fp_old["return_false_count"] - fp_new["return_false_count"],
            })
        if fp_old["conditional_count"] > fp_new["conditional_count"]:
            guard_removals.append({
                "file": nf["file"],
                "function": nf["function"],
                "conditional_loss": fp_old["conditional_count"] - fp_new["conditional_count"],
            })

    diff_result = {
        "added_authority_functions": [{"file": f, "function": n} for f, n in added],
        "removed_authority_functions": [{"file": f, "function": n} for f, n in removed],
        "changed_fingerprints": changed,
        "guard_removals": guard_removals,
        "new_violations": new.get("violations", []),
        "summary": {
            "additions": len(added),
            "removals": len(removed),
            "fingerprint_changes": len(changed),
            "guard_removals": len(guard_removals),
            "new_violations": len(new.get("violations", [])),
            "safe": len(changed) == 0 and len(guard_removals) == 0,
        },
    }

    print(json.dumps(diff_result, indent=2, ensure_ascii=False, default=str))

    if not diff_result["summary"]["safe"]:
        print(f"\n[AUTHORITY INVARIANT] WARNING: Semantic drift detected!", file=sys.stderr)
        if guard_removals:
            print(f"[AUTHORITY INVARIANT] Guard removals: {len(guard_removals)}", file=sys.stderr)
        sys.exit(2)
    else:
        print(f"\n[AUTHORITY INVARIANT] OK: No semantic drift", file=sys.stderr)


def main():
    if len(sys.argv) < 2:
        print("Usage: authority_invariant.py <scan|lock|diff> [--root <dir>]", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    root = DEFAULT_ROOT
    for i, arg in enumerate(sys.argv):
        if arg == "--root" and i + 1 < len(sys.argv):
            root = Path(sys.argv[i + 1]).resolve()

    if not root.exists():
        print(f"[AUTHORITY INVARIANT] Root not found: {root}", file=sys.stderr)
        sys.exit(1)

    if cmd == "scan":
        cmd_scan(root)
    elif cmd == "lock":
        cmd_lock(root)
    elif cmd == "diff":
        cmd_diff(root)
    else:
        print(f"Unknown: {cmd}", file=sys.stderr)
        sys.exit(1)


def _hook_safe_entry():
    """ACS PreToolUse hook 安全入口 — 无参数时默认 scan 模式静默退出。"""
    try:
        import sys
        # 如果没有命令行参数，以 scan 模式静默运行
        if len(sys.argv) < 2:
            sys.argv = [sys.argv[0], "scan", "--root", os.path.expanduser("~/.claude")]
        main()
    except SystemExit:
        pass  # 吞掉 usage 错误，不阻塞 Claude

if __name__ == "__main__":
    _hook_safe_entry()
