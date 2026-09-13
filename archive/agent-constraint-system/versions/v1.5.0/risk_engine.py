#!/usr/bin/env python3
"""
risk_engine.py — Proposal Risk Engine (v1.2.0)
将 export_graph.py 的结构 diff 转化为自动化治理决策。

v1.2.0 改动 (#2 stdin 降级):
  - 加 _is_proposal_json() 检测 hook JSON vs 真实 proposal JSON
  - --stdin 收到非 proposal JSON → 静默退出 0 (不评估, 不报 BLOCK)

用法:
  python3 risk_engine.py assess [--proposal <proposal.json>] [--root <dir>]
  python3 risk_engine.py assess --stdin   # 从 stdin 读取 Proposal JSON (hook 调用 → 静默)

输入 (Proposal JSON):
  {
    "id": "P-123",
    "title": "...",
    "agent": "claude-sonnet",
    "files": ["path/to/file.ts", ...],
    "description": "...",
    "risk_self_assessment": "low"  // optional
  }

输出 (RiskAssessment):
  {
    "score": 85,
    "level": "BLOCK",
    "reasons": [...],
    "required_approvals": 2,
    "cooldown_hours": 0,
    "requires_human_review": true,
    "requires_kernel_review": false
  }

风险组合规则:
  - 加法: 各维度分数累加
  - 乘数: kernel 路径修改 ×3, security 路径 ×5
  - 协同: ≥3 项 HIGH/CRITICAL → +30 synergy penalty
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# ============================================================
# 配置
# ============================================================
CWD = Path(os.environ.get("CLAUDE_CWD", os.getcwd())).resolve()
GOVERNANCE = CWD / ".claude" / "governance"
EXPORT_GRAPH = CWD / ".claude" / "hooks" / "export_graph.py"
DEFAULT_ROOT = CWD / "my-project" / "projects" / "gaokao" / "frontend" / "src"

# 路径风险乘数
PATH_RISK_MULTIPLIERS = {
    "kernel": {"pattern": ["core-lite/kernel", "runtime/", "governance/"], "multiplier": 3, "label": "kernel"},
    "security": {"pattern": ["auth/", "permission", "security/"], "multiplier": 5, "label": "security"},
    "data": {"pattern": ["data/", "database", "migration/"], "multiplier": 2, "label": "data"},
    "api": {"pattern": ["api/", "endpoint", "route/", "handler"], "multiplier": 2, "label": "api"},
    "contract": {"pattern": ["types.", "interface.", "contract"], "multiplier": 2, "label": "contract"},
}

# 风险等级阈值
RISK_LEVELS = [
    (0, "AUTO", 0, 0),
    (5, "WARN", 0, 0),
    (20, "REVIEW", 1, 0),
    (50, "BLOCK", 2, 0),
    (100, "SECURITY_ESCALATION", 3, 24),
]

# 协同效应阈值
SYNERGY_THRESHOLD = 3    # ≥3 项 HIGH/CRITICAL 触发
SYNERGY_PENALTY = 30

# 硬规则：这些组合直接 BLOCK，不通过分数
HARD_BLOCK_COMBOS = [
    (["export_deletions", "interface_shrinks"], "export 删除 + interface 收缩 → 结构性破坏"),
    (["export_deletions", "generic_constraint_losses"], "export 删除 + 泛型约束丢失 → ABI 崩溃"),
]

# 单文件风险上限
MAX_FILE_RISK = 200


# ============================================================
# v1.2.0 #2: stdin 优雅降级
# ============================================================

def _is_proposal_json(data: Any) -> bool:
    """检测 stdin JSON 是否真的是 Proposal。

    Proposal JSON 特征: 含 id, files, description 等
    Hook JSON (Claude Code PostToolUse) 特征: 含 tool_name, tool_input, session_id
    """
    if not isinstance(data, dict):
        return False
    # Hook JSON 标志
    if any(k in data for k in ("tool_name", "tool_input", "session_id", "hookEventName")):
        return False
    # Proposal JSON 至少要有 id 或 files
    if any(k in data for k in ("id", "files", "description", "title")):
        return True
    return False


# ============================================================
# 核心逻辑 (与 v1.1.0 相同, 此处省略完整复述, 保持原样)
# ============================================================

def _load_structural_diff(root: Path) -> dict:
    """运行 export_graph.py diff 获取结构差异"""
    empty = {"changes": {}, "integrity": {"violations": []}, "risk": {"breakdown": {}}}
    if not EXPORT_GRAPH.exists():
        print(f"[RISK ENGINE] WARNING: {EXPORT_GRAPH} not found — structural diff SKIPPED, "
              f"risk score will NOT reflect ABI/structural changes", file=sys.stderr)
        return empty
    try:
        r = subprocess.run(
            ["python3", str(EXPORT_GRAPH), "diff", "--root", str(root)],
            capture_output=True, text=True, timeout=60,
            env={**os.environ, "CLAUDE_CWD": str(CWD)},
        )
        stdout = r.stdout
        start = stdout.find("{")
        if start >= 0:
            return json.loads(stdout[start:])
        print(f"[RISK ENGINE] WARNING: export_graph.py produced no parseable output "
              f"(returncode={r.returncode}, stderr={r.stderr[:200]!r})", file=sys.stderr)
    except Exception as e:
        print(f"[RISK ENGINE] Failed to load structural diff: {e}", file=sys.stderr)
    return empty


def _path_risk_multiplier(file_path: str) -> tuple:
    for category, config in PATH_RISK_MULTIPLIERS.items():
        for pat in config["pattern"]:
            if pat in file_path:
                return config["multiplier"], config["label"]
    return 1, "normal"


def _severity_for_category(category: str, file_path: str) -> str:
    mult, label = _path_risk_multiplier(file_path)
    if label == "kernel":
        return "CRITICAL"
    if label == "security":
        return "CRITICAL"
    if category in ("export_deletions", "interface_shrinks", "generic_constraint_losses"):
        return "CRITICAL"
    if category in ("any_increases", "unknown_increases", "optionalizations", "readonly_removals"):
        return "HIGH"
    return "MEDIUM"


def _build_risk_reasons(changes: dict, budget_violations: list) -> list:
    reasons = []
    category_map = {
        "export_deletions": ("ABI_BREAK", "EXPORT_REMOVAL", "export 删除"),
        "interface_shrinks": ("ABI_BREAK", "EXPORT_REMOVAL", "interface 字段删除"),
        "any_increases": ("ANY_POLLUTION", "ANY_POLLUTION", "any 使用增加"),
        "unknown_increases": ("ANY_POLLUTION", "ANY_POLLUTION", "unknown 使用增加"),
        "optionalizations": ("OPTIONALIZATION", "OPTIONALIZATION", "字段 optional 化"),
        "readonly_removals": ("ABI_BREAK", "OPTIONALIZATION", "readonly 移除"),
        "generic_constraint_losses": ("ABI_BREAK", "EXPORT_REMOVAL", "泛型约束丢失"),
        "unchecked_cast_increases": ("ANY_POLLUTION", "SEMANTIC_RISK", "unchecked cast 增加"),
        "dependency_fanout_spikes": ("FANOUT_SPIKE", "SEMANTIC_RISK", "依赖扇出激增"),
    }
    for change_key, (category, subcat, desc_template) in category_map.items():
        items = changes.get(change_key, [])
        for item in items:
            fp = item.get("file", "")
            mult, path_label = _path_risk_multiplier(fp)
            severity = _severity_for_category(change_key, fp)
            if path_label in ("kernel", "security") and severity != "CRITICAL":
                severity = "CRITICAL" if severity == "HIGH" else "HIGH"
            delta = item.get("delta", 0)
            symbol = item.get("symbol", item.get("interface", item.get("field", item.get("param", ""))))
            if not symbol and "removed_fields" in item:
                symbol = ", ".join(item["removed_fields"])
            reasons.append({
                "category": category,
                "subcategory": subcat,
                "severity": severity,
                "file": fp,
                "symbol": str(symbol) if symbol else None,
                "delta": delta,
                "path_label": path_label,
                "path_multiplier": mult,
                "explanation": f"{desc_template}: {fp}" + (f" ({symbol})" if symbol else ""),
            })
    for v in budget_violations:
        reasons.append({
            "category": "ABI_BREAK",
            "subcategory": "BUDGET_EXCEEDED",
            "severity": v.get("severity", "HIGH").upper(),
            "file": "N/A",
            "symbol": v.get("rule", ""),
            "delta": v.get("delta", 0),
            "explanation": f"Budget exceeded: {v['rule']} (allowed={v['allowed']}, actual={v['actual']})",
        })
    return reasons


def calculate_risk(changes: dict, integrity: dict, risk_breakdown: dict) -> dict:
    reasons = _build_risk_reasons(changes, integrity.get("violations", []))
    base_score = sum(item.get("score", 0) for item in (risk_breakdown or {}).values() if isinstance(item, dict))
    max_mult = 1
    path_labels = set()
    for reason in reasons:
        m = reason.get("path_multiplier", 1)
        if m > max_mult:
            max_mult = m
        if reason.get("path_label"):
            path_labels.add(reason["path_label"])
    high_critical_count = sum(1 for r in reasons if r["severity"] in ("HIGH", "CRITICAL"))
    hard_blocks = []
    for combo, desc in HARD_BLOCK_COMBOS:
        if all(len(changes.get(k, [])) > 0 for k in combo):
            hard_blocks.append(desc)
    score = base_score * max_mult
    if high_critical_count >= SYNERGY_THRESHOLD:
        score += SYNERGY_PENALTY
    if score > MAX_FILE_RISK:
        score = min(score, MAX_FILE_RISK)
    level = "AUTO"
    req_approvals = 0
    cooldown = 0
    for threshold, lvl, approvs, cool in sorted(RISK_LEVELS, key=lambda x: -x[0]):
        if score >= threshold:
            level = lvl
            req_approvals = approvs
            cooldown = cool
            break
    if level == "AUTO" and score > 0:
        level = "WARN"
    if hard_blocks:
        level = "BLOCK"
        score = max(score, 50)
        req_approvals = max(req_approvals, 2)
    if max_mult >= 5:
        level = "SECURITY_ESCALATION"
        score = max(score, 100)
        req_approvals = max(req_approvals, 3)
        cooldown = 24
    return {
        "score": score,
        "level": level,
        "base_score": base_score,
        "path_multiplier": max_mult,
        "path_labels": list(path_labels),
        "synergy_triggered": high_critical_count >= SYNERGY_THRESHOLD,
        "high_critical_count": high_critical_count,
        "hard_blocks": hard_blocks,
        "reasons": reasons,
        "required_approvals": req_approvals,
        "cooldown_hours": cooldown,
        "requires_human_review": level in ("REVIEW", "BLOCK", "SECURITY_ESCALATION"),
        "requires_kernel_review": level == "SECURITY_ESCALATION",
        "assessed_at": time.time(),
    }


def cmd_assess(proposal: dict, root: Path) -> dict:
    proposal_id = proposal.get("id", "unknown")
    files = proposal.get("files", [])
    description = proposal.get("description", "")
    self_risk = proposal.get("risk_self_assessment", "unknown")
    print(f"[RISK ENGINE] Assessing proposal {proposal_id}: {len(files)} files", file=sys.stderr)
    structural = _load_structural_diff(root)
    assessment = calculate_risk(
        structural.get("changes", {}),
        structural.get("integrity", {}),
        structural.get("risk", {}),
    )
    assessment["proposal"] = {
        "id": proposal_id,
        "title": proposal.get("title", ""),
        "agent": proposal.get("agent", "unknown"),
        "files_count": len(files),
        "files": files,
        "self_assessment": self_risk,
        "self_vs_actual": _compare_assessment(self_risk, assessment["level"]),
    }
    return assessment


def _compare_assessment(self_risk: str, actual_level: str) -> str:
    levels_order = ["AUTO", "WARN", "REVIEW", "BLOCK", "SECURITY_ESCALATION"]
    try:
        diff = levels_order.index(actual_level) - levels_order.index(
            {"low": "AUTO", "medium": "REVIEW", "high": "BLOCK", "critical": "SECURITY_ESCALATION"}.get(
                self_risk, "AUTO"))
        if diff > 1:
            return "AGENT_UNDERESTIMATED"
        elif diff >= 0:
            return "ALIGNED"
        else:
            return "AGENT_OVERESTIMATED"
    except (ValueError, IndexError):
        return "UNKNOWN"


def cmd_score(changes_file: str) -> dict:
    with open(changes_file) as f:
        data = json.load(f)
    return calculate_risk(
        data.get("changes", {}),
        data.get("integrity", {}),
        data.get("risk", {}),
    )


# ============================================================
# 入口
# ============================================================

def main():
    if len(sys.argv) < 2:
        print("Usage: risk_engine.py <assess|score> [options]", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    root = DEFAULT_ROOT

    for i, arg in enumerate(sys.argv):
        if arg == "--root" and i + 1 < len(sys.argv):
            root = Path(sys.argv[i + 1]).resolve()

    if cmd == "assess":
        proposal = {"id": f"adhoc-{int(time.time())}", "files": []}

        for i, arg in enumerate(sys.argv):
            if arg == "--proposal" and i + 1 < len(sys.argv):
                with open(sys.argv[i + 1]) as f:
                    proposal = json.load(f)
            if arg == "--stdin":
                stdin_data = json.load(sys.stdin)
                # v1.2.0 #2: 优雅降级 - 如果 stdin 不是 proposal JSON, 静默退出
                if not _is_proposal_json(stdin_data):
                    sys.exit(0)
                proposal = stdin_data

        result = cmd_assess(proposal, root)
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

        level = result["level"]
        if level in ("BLOCK", "SECURITY_ESCALATION"):
            print(f"\n[RISK ENGINE] {level}: Proposal blocked ({result['score']} points)", file=sys.stderr)
            sys.exit(2)
        elif level == "REVIEW":
            print(f"\n[RISK ENGINE] REVIEW: Human review required ({result['score']} points)", file=sys.stderr)
        else:
            print(f"\n[RISK ENGINE] {level}: {result['score']} points", file=sys.stderr)

    elif cmd == "score":
        if len(sys.argv) < 3 or sys.argv[2] not in ("--changes", "--stdin"):
            print("Usage: risk_engine.py score --changes <file.json>", file=sys.stderr)
            sys.exit(1)
        if sys.argv[2] == "--stdin":
            data = json.load(sys.stdin)
            result = calculate_risk(
                data.get("changes", {}), data.get("integrity", {}), data.get("risk", {}))
        else:
            result = cmd_score(sys.argv[3])
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

    else:
        print(f"Unknown: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
