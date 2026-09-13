#!/usr/bin/env python3
"""
acs_lite.py — ACS v1.5.0 统一优化版

v1.5.0 变更 (2026-07-13):
- _load_scope() 统一读取 ACTIVE_TASK.json 权威源，消除双文件同步风险

v5.2 变更 (2026-07-13):
- 扩展保护至 settings.json, settings.local.json, CLAUDE.md, .claude.json

v5.1 变更 (2026-07-13):
- 扩展 ACS_SYSTEM_FILES 和 _is_acs_system_path 至完整 runtime/ 目录

v5.0 变更 (2026-06-06):
  v5.0  止血层 + Token Budget Controller + 上下文裁剪 一体化
  v5.0a Bug 修复: 双重 CATEGORY_MAP, _load_scope vs load_scope, Read 事件丢失
  v5.0b 架构: 单文件自包含，零外部依赖（除 acs_paths/acs_violations/acs_structural）

集成模块:
  - Token Budget Controller (自动模型降级 / 成本追踪)
  - Context Pruner (120k/200k 阈值 + /compact 支持)
  - Diff-only 文件读取 (禁止全文回灌)
  - 重复定义消除 + scope 一致性修复
"""
from __future__ import annotations

# Cursor Agent auto-imports Claude hooks from ~/.claude/settings*.json.
# ACS/ORCH is Claude-only — never gate Cursor sessions.
_e = __import__("os").environ
# Cursor Agent injects CURSOR_PROJECT_DIR / CURSOR_VERSION into hook env (not CURSOR_AGENT).
if _e.get("CURSOR_PROJECT_DIR") or _e.get("CURSOR_VERSION") or _e.get("CURSOR_AGENT"):
    raise SystemExit(0)

import datetime
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ── 模块化导入 ──────────────────────────────────────────
from acs_paths import (
    resolve_zone, FileZone, ZONE_PERMISSIONS, is_mass_delete,
    PROJECT, RUNTIME_DIR, AUDIT_DIR, SHADOW_ROOT,
    SCOPE_FILE, VIOLATION_FILE, ACTIVE_TASK_FILE, INTEGRITY_FILE, LOCK_FILE, PROPOSAL_FILE,
    HOOKS_DIR, TEMPLATE_DIR,
    resolve, is_protected, is_always_writable, is_shadow_workspace,
    is_writable, is_in_scope, is_abi_protected,
)
from acs_violations import (
    load_violations, save_violations, add_violation, clear_violations,
    should_lock, window_score, total_score,
    integrity_store, integrity_verify,
    integrity_chain_verify, integrity_chain_stats,
    WINDOW_THRESHOLD, LOCK_DENY_SCORE,
)
from asset_ledger import AssetLedger
from safe_mode import SafeMode

# Initialize runtime protection modules
_asset_ledger = AssetLedger(str(RUNTIME_DIR / "asset_ledger.json"))
_safe_mode = SafeMode()
from acs_structural import verify_structural_change, SUPPORTED_SUFFIXES

# ═════════════════════════════════════════════════════════════════════════
#  TOKEN BUDGET CONFIG (止血层核心配置)
# ═════════════════════════════════════════════════════════════════════════
TOKEN_SOFT_LIMIT    = 800_000    # 触发自动压缩
# TOKEN_HARD_LIMIT    = 2_000_000    # 强制开新会话 [DISABLED by user request]
COMPACT_INTERVAL    = 25         # 每 25 轮执行一次 /compact
MAX_HISTORY_ROUNDS  = 3          # Working Memory 保留最近 N 轮

MODEL_COSTS = {
    "claude-sonnet-4":  {"input": 3.0,   "output": 15.0},
    "claude-haiku-3.5": {"input": 0.25,  "output": 1.25},
    "glm-4-flash":      {"input": 0.02,  "output": 0.1},
    "deepseek-v3":      {"input": 0.27,  "output": 1.1},
    "minimax-ab01":     {"input": 0.1,   "output": 0.6},
}
DEGRADE_CHAIN = [
    "claude-sonnet-4",
    "claude-haiku-3.5",
    "deepseek-v3",
    "glm-4-flash",
    "minimax-ab01",
]

# ═════════════════════════════════════════════════════════════════════════
#  路径 & 持久化文件
# ═════════════════════════════════════════════════════════════════════════
SCRIPT_DIR  = Path(os.path.dirname(os.path.abspath(__file__))).resolve()
PROJECT     = SCRIPT_DIR.parent.parent

BUDGET_FILE  = RUNTIME_DIR / "TOKEN_BUDGET.json"
CONTEXT_FILE = RUNTIME_DIR / "CONTEXT_STATE.json"
MODE_FILE    = RUNTIME_DIR / "MODE.json"

# MODE cache: avoid re-reading MODE_FILE on every check_bash/check_write call
_MODE_CACHE: Dict[str, object] = {"mode": "UNKNOWN", "mtime": 0.0}
RESEARCH_MODES = {"ACTIVE", "RESEARCH"}


def _current_mode() -> str:
    try:
        mtime = MODE_FILE.stat().st_mtime
        if mtime == _MODE_CACHE["mtime"]:
            return str(_MODE_CACHE["mode"])
        data = json.loads(MODE_FILE.read_text())
        mode = data.get("mode", "UNKNOWN")
        _MODE_CACHE["mode"] = mode
        _MODE_CACHE["mtime"] = mtime
        return mode
    except (OSError, json.JSONDecodeError):
        return "UNKNOWN"

# ═════════════════════════════════════════════════════════════════════════
#  行为基线 (Baseline) — 无 scope 时只允许只读命令
# ═════════════════════════════════════════════════════════════════════════
SCOPE_BASELINE_COMMANDS = frozenset({
    "ls", "cat", "find", "grep", "head", "tail", "wc", "pwd", "echo",
    "env", "stat", "file", "which", "whoami", "id", "date", "tree",
    "du", "df", "free", "ps", "uname", "printenv", "nl", "cut", "tr",
    "sort", "uniq", "comm", "diff", "od", "mkdir", "touch", "jq",
    "git", "python", "python3", "node",  # 子命令二次过滤
})

BASELINE_DENY_PATTERNS = [
    (r">\s*\S+",                            "redirect (write attempt)"),
    (r"\|\s*(?:sh|bash)\b",                 "pipe to shell"),
    (r"\brm\s+",                            "rm command"),
    (r"\bchmod\s+",                         "chmod"),
    (r"\bchown\s+",                         "chown"),
    (r"\bsudo\b",                           "sudo"),
    (r"\bsu\s+",                            "su"),
    (r"\bmkfs\b",                           "mkfs"),
    (r"\bdd\s+",                            "dd"),
    (r"\bmount\b",                          "mount"),
    (r"\bumount\b",                         "umount"),
    (r"\bsystemctl\b",                      "systemctl"),
    (r"\bapt(-get)?\b",                     "apt"),
    (r"\bnpm\s+install\b",                  "npm install"),
    (r"--force|--hard|-rf\b",               "force/hard flag"),
    (r"\b(?:node|python3?|perl|ruby|php|lua)\s+-[ce]\b", "inline interpreter (no scope)"),
    (r"\b(?:python3?|node|perl|ruby|bash)\s+<<",         "heredoc interpreter (no scope)"),
]
BASELINE_DENY_COMPILED = [(re.compile(p, re.I), desc) for p, desc in BASELINE_DENY_PATTERNS]

# 危险 Bash 模式（行为语义分类）─ v5.0 去重，单一定义 ──────────
DANGEROUS_BASH: List[Tuple[str, str]] = [
    # DELETE 类 ──────────────────────────────────
    # FAIL-CLOSED core policy: any recursive remove (`rm -r` / `rm -rf` /
    # `rm -fr` / `rm -Rf`, bare or any target) is ALWAYS blocked, regardless
    # of target directory. No CONFIRM. Scores as SYSTEM (100 → 秒锁) so the
    # "dangerous command → block + deduct" rule is uniform across all engines.
    (r"\brm\b\s+-[a-zA-Z]*[rR][a-zA-Z]*\b", "rm recursive (rm -rf) — always blocked"),
    (r"(?:^|[|;&]\s*)rm\s+-[a-zA-Z]*[rf]\s+/(?:\s|$)",   "rm -rf /"),
    (r"(?:^|[|;&]\s*)rm\s+-[a-zA-Z]*[rf]\s+\*",          "rm -rf *"),
    (r"(?:^|[|;&]\s*)rm\s+-[a-zA-Z]*[rf]\s+~",            "rm -rf ~"),
    (r"(?:^|[|;&]\s*)rm\s+-[a-zA-Z]*[rf]\s+\S*PROJ",     "rm -rf project"),
    (r"(?:^|[|;&]\s*)rm\s+\S+",                            "rm file"),
    (r"\btruncate\s+-s\s+0",                               "truncate to zero"),
    # WRITE 类 ──────────────────────────────────
    (r"\bchmod\s+777\b",                                   "chmod 777"),
    (r"\bchown\s+root\b",                                  "chown root"),
    (r">\s*/etc/",                                          "overwrite system file"),
    (r"\bhistory\s+-[cw]\b",                               "clear shell history"),
    (r"\bunset\s+HISTFILE\b",                              "disable shell history"),
    # EXEC 类 ──────────────────────────────────
    (r"\b(?:node|python3?|perl|ruby|php|lua)\s+-[ce]\b",  "inline interpreter"),
    (r"\b(?:python3?|node|perl|ruby|bash)\s+<<",           "heredoc interpreter"),
    # SYSTEM 类 ─────────────────────────────────
    (r"(?:^|[|;&]\s*)mkfs\.",                               "mkfs"),
    (r"(?:^|[|;&]\s*)dd\s+if=/dev/",                       "dd to block device"),
    (r"\breboot\b",                                         "reboot"),
    (r"\bshutdown\b",                                       "shutdown"),
    (r":\(\s*\)\s*\{",                                     "fork bomb"),
    (r"\bcat\s+/etc/(?:shadow|passwd)\b",                  "read /etc sensitive"),
    # NETWORK 类 ────────────────────────────────
    (r"\b(?:wget|curl)\b.*\|\s*(?:sh|bash)\b",             "download pipe shell"),
    (r"\bgit\s+push\s+--force\b",                          "git push --force"),
    (r"\bgit\s+reset\s+--hard\b",                          "git hard reset"),
    # ACS_SELF 类 ───────────────────────────────
    (r"\bchmod\s+.*-[a-z]*x[a-z]*.*acs_lite",              "chmod -x on ACS engine"),
    (r"(?:cat|tee|dd|cp|mv)\s+.*>\s*\S*acs_lite\.py",    "ACS tamper: engine"),
    (r"(?:cat|tee|dd|cp|mv)\s+.*>\s*\S*acs_paths\.py",    "ACS tamper: paths"),
    (r"(?:cat|tee|dd|cp|mv)\s+.*>\s*\S*acs_violations\.py","ACS tamper: violations"),
    (r"(?:cat|tee|dd|cp|mv)\s+.*>\s*\S*acs_structural\.py","ACS tamper: structural"),
    (r"(?:cat|tee|dd)\s+.*>\s*\S*\.claude/hooks/",        "ACS tamper: hooks dir"),
    (r"(?:cat|tee|dd)\s+.*>\s*\S*\.claude/runtime/",      "ACS tamper: runtime dir"),
    (r"(?:cat|tee|dd)\s+.*>\s*\S*\.claude/settings\.json","ACS tamper: settings"),
    (r"python3?\s+\S*acs_lite\.py\s+reset\b",             "ACS tamper: reset"),
    (r"rm\s+\S*\.claude/(hooks|runtime|governance|memory|audit)","ACS tamper: delete"),
    (r"sed\s+-i.*\.claude/(hooks|runtime|governance|memory)",   "ACS tamper: sed"),
]
COMPILED_BASH: List[Tuple[re.Pattern, str]] = [
    (re.compile(p, re.I), desc) for p, desc in DANGEROUS_BASH
]

# 行为分类映射表 — v5.0 唯一正规定义 (消除 v1.2.0 的重复 bug) ──
CATEGORY_MAP: Dict[str, str] = {
    # DELETE
    "rm recursive (rm -rf) — always blocked": "SYSTEM",
    "rm -rf /":              "DELETE",  "rm -rf *":         "DELETE",
    "rm -rf ~":              "DELETE",  "rm -rf project":   "DELETE",
    "rm file":               "DELETE",  "truncate to zero": "DELETE",
    # WRITE
    "chmod 777":             "WRITE",   "chown root":       "WRITE",
    "overwrite system file": "WRITE",   "clear shell history":"WRITE",
    "disable shell history": "WRITE",
    # EXEC
    "inline interpreter":    "EXEC",    "heredoc interpreter":"EXEC",
    # SYSTEM
    "mkfs":                  "SYSTEM",  "dd to block device":"SYSTEM",
    "reboot":                "SYSTEM",  "shutdown":          "SYSTEM",
    "fork bomb":             "SYSTEM",  "read /etc sensitive":"SYSTEM",
    # NETWORK
    "download pipe shell":   "NETWORK", "git push --force":  "NETWORK",
    "git hard reset":        "NETWORK",
    # ACS_SELF
    "chmod -x on ACS engine": "ACS_SELF","pip install":      "ACS_SELF",
    "npm global install":    "ACS_SELF","ACS tamper: engine":  "ACS_SELF",
    "ACS tamper: paths":     "ACS_SELF","ACS tamper: violations":"ACS_SELF",
    "ACS tamper: structural":"ACS_SELF","ACS tamper: hooks dir":"ACS_SELF",
    "ACS tamper: runtime dir":"ACS_SELF","ACS tamper: settings":"ACS_SELF",
    "ACS tamper: reset":     "ACS_SELF","ACS tamper: delete":  "ACS_SELF",
    "ACS tamper: sed":       "ACS_SELF",
}

CATEGORY_SCORES: Dict[str, int] = {
    "EXEC":     10,    # 运行代码    — 8次才锁
    "WRITE":    25,    # 修改数据    — 3次近锁
    "DELETE":   60,    # 删除结构    — 1次近锁
    "SYSTEM":   100,   # 系统破坏    — 秒锁
    "NETWORK":  60,    # 外部/远程   — 1次近锁
    "ACS_SELF": 100,   # ACS 自保护  — 秒锁
}
DEFAULT_CATEGORY = "WRITE"  # 未匹配 → WRITE 级

# v1.2.0 safety: session feedback 豁免
SESSION_FEEDBACK_RE = re.compile(
    r".*/\.claude/projects/[^/]+/(memory|journal)(/.*)?$"
)


# ═════════════════════════════════════════════════════════════════════════
#  辅助函数
# ═════════════════════════════════════════════════════════════════════════

def _load_scope() -> Dict:
    """v1.5.0: 统一 scope 读取 — ACTIVE_TASK.json 权威源，SCOPE_FILE 兼容回退。"""
    try:
        # v1.5.0: ACTIVE_TASK.json is the authoritative source
        if ACTIVE_TASK_FILE.exists():
            data = json.loads(ACTIVE_TASK_FILE.read_text())
            if data.get("task_id"):
                return data
    except (json.JSONDecodeError, OSError):
        pass
    # v1.5.0: fallback to SCOPE_FILE for backward compatibility
    try:
        if SCOPE_FILE.exists():
            return json.loads(SCOPE_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def _active_task_read() -> Dict:
    """读取 ACTIVE_TASK.json，缓存失效时从 SCOPE_FILE 重建。"""
    try:
        if ACTIVE_TASK_FILE.exists():
            data = json.loads(ACTIVE_TASK_FILE.read_text())
            if data.get("task_id") and data["task_id"] != "(none)":
                return data
    except (json.JSONDecodeError, OSError):
        pass
    # 回退：从 SCOPE_FILE 重建
    scope = _load_scope()
    if scope.get("task_id"):
        _active_task_write(
            scope["task_id"],
            scope.get("allowed_dirs", scope.get("allowed_files", [])),
            allowed_files=scope.get("allowed_files", scope.get("allowed_dirs", [])),
            blocked_commands=scope.get("blocked_commands", []),
            shadow_mode=scope.get("shadow_mode", False),
            proposal_required=scope.get("proposal_required", False),
        )
        return _active_task_read()
    return {}


def _active_task_write(
    task_id: str,
    allowed_dirs: List[str],
    allowed_files: Optional[List[str]] = None,
    blocked_commands: Optional[List[str]] = None,
    shadow_mode: bool = False,
    proposal_required: bool = False,
) -> None:
    if allowed_files is None:
        allowed_files = allowed_dirs
    if blocked_commands is None:
        blocked_commands = []
    doc = {
        "version": "5.0",
        "task": task_id,
        "task_id": task_id,
        "status": "ACTIVE",
        "allowed_dirs": allowed_dirs,
        "allowed_files": allowed_files,
        "blocked_commands": blocked_commands,
        "shadow_mode": shadow_mode,
        "proposal_required": proposal_required,
        "updated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    # v5.0: 统一只写 ACTIVE_TASK.json 作为权威源
    # SCOPE_FILE 仅作为兼容保留，check 时以 ACTIVE_TASK.json 优先
    ACTIVE_TASK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(ACTIVE_TASK_FILE, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
    # 兼容：同步一份到 SCOPE_FILE
    SCOPE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(SCOPE_FILE, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)


def _deny(reason: str) -> None:
    """v5.0 统一 deny 出口。"""
    payload = json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"[ACS v1.5.0] BLOCKED: {reason}",
        }
    })
    sys.stderr.write(payload + "\n")
    sys.exit(2)


def _gate_lock() -> None:
    """锁定检查。"""
    if not LOCK_FILE.exists():
        return
    v = load_violations()
    locked, reason = should_lock(v)
    if not locked:
        try:
            LOCK_FILE.unlink()
        except FileNotFoundError:
            pass
        return
    _deny(f"system locked — {LOCK_FILE.read_text().strip()} ({reason})")


# ═════════════════════════════════════════════════════════════════════════
#  止血层 A: Token Budget Controller
# ═════════════════════════════════════════════════════════════════════════

def _load_budget() -> Dict:
    """加载 Token 预算状态。"""
    try:
        if BUDGET_FILE.exists():
            return json.loads(BUDGET_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_cost_usd": 0.0,
        "current_model": "claude-sonnet-4",
        "session_count": 0,
        "last_reset": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "degradation_log": [],
    }


def _save_budget(budget: Dict) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    with open(BUDGET_FILE, "w") as f:
        json.dump(budget, f, indent=2, ensure_ascii=False)


def _budget_add_usage(input_tokens: int, output_tokens: int, model: Optional[str] = None) -> Tuple[Dict, Optional[str]]:
    """
    记录 Token 使用并检查是否需要降级。
    返回: (new_budget, action)  action: None | "degrade" | "compact" | "new_session"
    """
    budget = _load_budget()
    if model is None:
        model = budget.get("current_model", "claude-sonnet-4")

    inp_cost = (input_tokens / 1_000_000) * MODEL_COSTS.get(model, {}).get("input", 3.0)
    out_cost = (output_tokens / 1_000_000) * MODEL_COSTS.get(model, {}).get("output", 15.0)

    budget["total_input_tokens"] += input_tokens
    budget["total_output_tokens"] += output_tokens
    budget["total_cost_usd"] += inp_cost + out_cost
    budget["current_model"] = model
    budget["session_count"] += 1

    action: Optional[str] = None
    new_model = model
    combined = budget["total_input_tokens"] + budget["total_output_tokens"]

    # 检查是否需要降级
    current_idx = DEGRADE_CHAIN.index(model) if model in DEGRADE_CHAIN else -1
    if combined > 50_000 and current_idx >= 0 and current_idx < len(DEGRADE_CHAIN) - 1:
        projected = (combined / 1_000_000) * (MODEL_COSTS[model]["input"] + MODEL_COSTS[model]["output"])
        cheaper_name = DEGRADE_CHAIN[current_idx + 1]
        cheaper_cost = (combined / 1_000_000) * (MODEL_COSTS[cheaper_name]["input"] + MODEL_COSTS[cheaper_name]["output"])
        if cheaper_cost < projected * 0.5:
            new_model = cheaper_name
            action = "degrade"

    # 检查压缩 / 新会话
    # [DISABLED by user request] TOKEN_HARD check
    # if combined > TOKEN_HARD_LIMIT:
    #     action = "new_session"
    if combined > TOKEN_SOFT_LIMIT:
        action = "compact"

    budget["degradation_log"].append({
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "model": model,
        "new_model": new_model,
        "action": action,
        "cumulative_cost_usd": round(budget["total_cost_usd"], 4),
    })

    if action == "degrade":
        budget["current_model"] = new_model

    _save_budget(budget)
    return budget, action


def _budget_get_report() -> Dict:
    budget = _load_budget()
    inp = budget.get("total_input_tokens", 0)
    out = budget.get("total_output_tokens", 0)
    cost = budget.get("total_cost_usd", 0)
    model = budget.get("current_model", "?")
    idx = DEGRADE_CHAIN.index(model) if model in DEGRADE_CHAIN else -1

    return {
        "total_input_tokens": inp,
        "total_output_tokens": out,
        "total_tokens": inp + out,
        "total_cost_usd": round(cost, 4),
        "current_model": model,
        "sessions": budget.get("session_count", 0),
        "degradation_log_entries": len(budget.get("degradation_log", [])),
        "can_downgrade": idx >= 0 and idx < len(DEGRADE_CHAIN) - 1,
        "degrade_to": DEGRADE_CHAIN[idx + 1] if idx >= 0 and idx < len(DEGRADE_CHAIN) - 1 else None,
    }


def _budget_reset() -> Dict:
    budget = _load_budget()
    budget.update({
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "total_cost_usd": 0.0,
        "current_model": "claude-sonnet-4",
        "session_count": 0,
        "last_reset": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    })
    _save_budget(budget)
    return budget


# ═════════════════════════════════════════════════════════════════════════
#  止血层 B: 上下文裁剪 (Context Pruner)
# ═════════════════════════════════════════════════════════════════════════

def _estimate_tokens(text: str) -> int:
    """粗略估算 token 数。"""
    if not text:
        return 0
    return max(len(text) // 4, len(re.findall(r'[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]', text)))


def _load_context_state() -> Dict:
    try:
        if CONTEXT_FILE.exists():
            return json.loads(CONTEXT_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {"rounds_since_compact": 0, "needs_compact": False, "last_compact_ts": None}


def _save_context_state(state: Dict) -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONTEXT_FILE, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


def context_tick() -> Tuple[bool, str]:
    """
    每轮对话调用。
    返回: (should_compact: bool, warning_message: str)
    """
    state = _load_context_state()
    state["rounds_since_compact"] += 1

    if state["rounds_since_compact"] >= COMPACT_INTERVAL:
        state["needs_compact"] = True
        state["rounds_since_compact"] = 0
        state["last_compact_ts"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        _save_context_state(state)
        return True, f"[ACS v1.5.0] COMPACT_DUE — {COMPACT_INTERVAL} rounds elapsed. Run /compact to continue."

    _save_context_state(state)
    return False, ""


def context_compact_done() -> None:
    """/compact 执行完毕后调用，重置标记。"""
    state = _load_context_state()
    state["needs_compact"] = False
    state["rounds_since_compact"] = 0
    _save_context_state(state)


def prune_messages(messages: List[Dict]) -> Tuple[List[Dict], int, str]:
    """
    上下文裁剪 — 止血层核心:
    保留: 任务目标(1段) + 当前代码diff + 关键状态JSON
    删除: 历史对话全文 / 工具输出原文 / 已完成步骤日志

    返回: (pruned_messages, total_tokens, action)
      action: "ok" | "compressed" | "force_new_session"
    """
    raw = "\n".join(json.dumps(m) for m in messages)
    total = _estimate_tokens(raw)

    if total < TOKEN_SOFT_LIMIT:
        return messages, total, "ok"

    # [DISABLED by user request] TOKEN_HARD check
    # if total >= TOKEN_HARD_LIMIT:
    #     return [], total, "force_new_session"

    # ---- 压缩模式 ----
    pruned: List[Dict] = []
    rounds_kept = 0
    seen_tool = False

    for msg in reversed(messages):
        role = msg.get("role", "")

        # 永远保留 system 中的任务目标 (取第一段)
        if role == "system" and rounds_kept == 0:
            text = msg.get("content", "")
            if isinstance(text, str):
                task_line = next((l for l in text.strip().split("\n")
                                  if any(kw in l.lower() for kw in ["task", "goal", "目标", "任务"])),
                                 text.strip().split("\n")[0] if text.strip() else "")
                pruned.insert(0, {
                    "role": "system",
                    "content": "[pruned] " + task_line.strip()[:300]
                })
            else:
                pruned.insert(0, msg)
            continue

        # 保留最近 N 轮对话
        if role in ("user", "assistant"):
            if rounds_kept < MAX_HISTORY_ROUNDS:
                content = msg.get("content", "")
                if isinstance(content, str) and len(content) > 800:
                    content = content[-800:] + "\n...[context pruned]"
                pruned.insert(0, {"role": role, "content": content})
                rounds_kept += 1
            continue

        # Tool 消息: 仅保留摘要
        if role == "tool" and not seen_tool:
            seen_tool = True
            original = msg.get("content", "")
            if isinstance(original, str) and len(original) > 500:
                pruned.insert(0, {
                    "role": "tool",
                    "content": "[summary] " + _summarize_tool_result(original)[:500]
                })
            else:
                pruned.insert(0, msg)
            continue

    if not any(m.get("role") == "system" for m in pruned):
        pruned.insert(0, {
            "role": "system",
            "content": "[pruned] Task in progress — please continue."
        })

    new_total = _estimate_tokens("\n".join(json.dumps(m) for m in pruned))
    return pruned, new_total, "compressed"


def _summarize_tool_result(text: str) -> str:
    """工具输出摘要化: summary + changed lines + key symbols。"""
    if not text or len(text) < 300:
        return text
    lines = text.split("\n")
    changed, symbols = [], []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("+") and not stripped.startswith("+++"):
            changed.append(stripped[:120])
        elif stripped.startswith("-") and not stripped.startswith("---"):
            changed.append(stripped[:120])
        for m in re.finditer(r'(?:export\s+(?:function|class|const|type|interface)\s+(\w+))', stripped):
            symbols.append(m.group(1))
    summary_lines = lines[:3] + ["..."] + lines[-3:] if len(lines) > 6 else lines
    summary = " | ".join(l.strip()[:100] for l in summary_lines if l.strip())
    parts = ["summary: " + summary[:300]]
    if symbols:
        parts.append("symbols: " + ", ".join(symbols[:10]))
    if changed:
        parts.append(f"changed({len(changed)}): " + " | ".join(changed[:15]))
    return "\n".join(parts)


# ═════════════════════════════════════════════════════════════════════════
#  止血层 C: Diff-only 文件读取
# ═════════════════════════════════════════════════════════════════════════

def read_file_diff(path_str: str, max_lines: int = 50) -> Dict:
    """
    Diff-only 读取: 返回 summary + changed regions，不返回全文。
    替代方案: Read file → 返回完整文件 → 塞入上下文 (token 浪费)
    """
    p = resolve(path_str)
    if not p.exists():
        return {"error": "file not found", "path": str(p)}
    try:
        text = p.read_text(encoding="utf-8")
    except Exception as e:
        return {"error": str(e), "path": str(p)}

    lines = text.split("\n")
    total_lines = len(lines)
    total_chars = len(text)

    if total_lines > 500 or total_chars > 10_000:
        key_sections = []
        current_func, brace_depth, func_start = None, 0, None
        for i, line in enumerate(lines, 1):
            stripped = line.strip()
            decl_match = re.match(
                r'^(export\s+)?(async\s+)?(function|class|interface|type|const|enum)\s+(\w+)',
                stripped
            )
            if decl_match:
                if current_func and func_start:
                    key_sections.append({
                        "name": current_func,
                        "lines": f"{func_start}-{i - 1}",
                        "preview": "\n".join(lines[func_start - 1: min(func_start + 3, i - 1)])[:200]
                    })
                current_func, func_start = decl_match.group(4), i
                brace_depth = stripped.count("{") - stripped.count("}")
            elif current_func:
                brace_depth += stripped.count("{") - stripped.count("}")
                if brace_depth <= 0:
                    key_sections.append({
                        "name": current_func,
                        "lines": f"{func_start}-{i}",
                        "preview": "\n".join(lines[func_start - 1: min(func_start + 5, i)])[:300]
                    })
                    current_func, func_start, brace_depth = None, None, 0
        if current_func and func_start:
            key_sections.append({"name": current_func, "lines": f"{func_start}-{total_lines}"})

        return {
            "path": str(p), "mode": "summary",
            "total_lines": total_lines, "total_chars": total_chars,
            "sections": key_sections[:20],
            "head": "\n".join(lines[:10]),
            "tail": "\n".join(lines[-5:]),
        }
    return {"path": str(p), "mode": "full", "total_lines": total_lines, "content": text[:5000]}


# ═════════════════════════════════════════════════════════════════════════
#  行为分类工具
# ═════════════════════════════════════════════════════════════════════════

def _classify_bash(desc: str) -> str:
    """根据 desc 查分类。"""
    return CATEGORY_MAP.get(desc, DEFAULT_CATEGORY)




def is_session_feedback(path_str: str) -> bool:
    return bool(SESSION_FEEDBACK_RE.match(path_str))


def _check_baseline_command(command: str) -> Optional[str]:
    """无 scope 时检查是否为 baseline 只读命令。返回 deny 原因或 None。"""
    for pattern, desc in BASELINE_DENY_COMPILED:
        if pattern.search(command):
            return f"baseline_deny: {desc}"

    parts = command.strip().split(None, 1)
    if not parts:
        return None
    exe = Path(parts[0]).name
    if exe not in SCOPE_BASELINE_COMMANDS:
        return f"not_in_baseline: {exe} (no scope initialized)"

    if exe == "git":
        git_subcommands = {
            "status", "log", "diff", "show", "branch", "tag", "remote",
            "config", "rev-parse", "ls-files", "ls-tree", "cat-file",
            "blame", "shortlog", "describe", "stash", "stash list", "reflog",
            "pull", "fetch", "clone",  # v5.0 新增安全子命令
        }
        git_args = parts[1] if len(parts) > 1 else ""
        first_git = git_args.strip().split(None, 1)[0] if git_args.strip() else ""
        if first_git not in git_subcommands:
            return f"git {first_git} not_in_baseline (no scope)"

    # python3/node 只允许版本查看和帮助
    if exe in ("python", "python3", "node"):
        sub_args = parts[1] if len(parts) > 1 else ""
        if sub_args and not sub_args.startswith(("-V", "--version", "-h", "--help")):
            # 在 baseline 中拦截 -c / -e / heredoc
            if re.search(r'^-[ce]', sub_args) or "<<-" in sub_args:
                return f"baseline_deny: {exe} inline execution (no scope)"

    return None


# ═════════════════════════════════════════════════════════════════════════
#  提案推断 (v5.0 优化: 从外部 JSON 配置读取 ALLOWED_PREFIXES)
# ═════════════════════════════════════════════════════════════════════════

PROPOSAL_ALLOWED_FILE = RUNTIME_DIR / "proposal_allowed_paths.json"


def _get_proposal_allowed_prefixes() -> List[Path]:
    """从配置文件读取允许路径，支持热更新。"""
    default_prefixes = [
        Path.home() / ".claude" / "runtime",
        Path.home() / ".claude" / "audit",
        Path.home() / ".claude" / "snapshots",
        Path.home() / ".claude" / "governance",
        Path.home() / ".claude" / "hooks",
        PROJECT,
        Path("/tmp/claude-shadow"),
        Path("/tmp"),
    ]
    try:
        if PROPOSAL_ALLOWED_FILE.exists():
            data = json.loads(PROPOSAL_ALLOWED_FILE.read_text())
            paths = [Path(p) for p in data.get("allowed_prefixes", [])]
            if paths:
                return paths
    except (json.JSONDecodeError, OSError, TypeError):
        pass
    return default_prefixes


def _infer_proposal_from_path(file_path: str) -> bool:
    """v5.0 P0-1b: 路径推断 — 从配置文件读取 ALLOWED_PREFIXES。"""
    if not file_path:
        return True
    resolved = Path(file_path).resolve()
    HOME = Path.home().resolve()

    if not (resolved.is_relative_to(HOME) or resolved.is_relative_to(Path("/tmp"))):
        return True  # 逃出 HOME → 需要 proposal

    for prefix in _get_proposal_allowed_prefixes():
        if resolved == prefix or resolved.is_relative_to(prefix):
            return False
    return True


def _check_proposal(file_path: str, tool_input: Dict) -> bool:
    """检查 proposal 是否存在且有效。"""
    scope = _load_scope()
    if not scope.get("proposal_required", False):
        return True
    proposal_id = tool_input.get("_proposal_id", "") or os.environ.get("CLAUDE_PROPOSAL_ID", "")
    if not proposal_id:
        return False
    if not PROPOSAL_FILE.exists():
        return False
    try:
        with open(PROPOSAL_FILE) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                p = json.loads(line)
                if p.get("id") == proposal_id and p.get("status") == "approved":
                    if time.time() - p.get("approved_at", 0) < 1800:
                        return True
    except (json.JSONDecodeError, OSError):
        return False
    return False


# ═════════════════════════════════════════════════════════════════════════
#  检查入口
# ═════════════════════════════════════════════════════════════════════════


def _is_acs_system_path(resolved: Path) -> bool:
    """v5.0: ACS self-protection — block modification of ACS system files."""
    hooks_dir = Path.home() / ".claude" / "hooks"
    runtime_dir = Path.home() / ".claude" / "runtime"
    try:
        resolved_str = str(resolved.resolve())
        # v5.1: entire directories
        if resolved_str.startswith(str(hooks_dir)):
            return True
        if resolved_str.startswith(str(runtime_dir)):
            return True
        # v5.2: critical config files (defense-in-depth)
        _critical = [
            str(Path.home() / ".claude" / "settings.json"),
            str(Path.home() / ".claude" / "settings.local.json"),
            str(Path.home() / ".claude" / "CLAUDE.md"),
            str(Path.home() / ".claude.json"),
        ]
        if resolved_str in _critical:
            return True
        return False
    except Exception:
        return False

def check_write(file_path: str, tool_name: str, tool_input: Dict) -> Dict:
    resolved = resolve(file_path)
    _gate_lock()

    # 0. Session feedback 豁免
    if is_session_feedback(file_path):
        return {"allowed": True, "reason": "session_feedback"}

    # 0.5 v5.0 ACS SELF-PROTECT (deny before any other check)
    if _is_acs_system_path(resolved):
        _deny(f"ACS_SELF_PROTECT: cannot modify ACS system file: {file_path} (score=100)")

    # 1. PROTECTED (始终 deny)
    if is_protected(resolved):
        w_score, locked, _ = add_violation(f"protected_path: {file_path}", 100)
        if locked:
            _deny(f"locked after protected_path attempt: {file_path} (window={w_score})")
        _deny(f"protected path — {file_path} (window={w_score})")

    # 2. ALWAYS_WRITABLE / SHADOW 放行
    if is_always_writable(resolved) or is_shadow_workspace(resolved):
        return {"allowed": True, "reason": "always_writable_or_shadow"}

    # 3. ZONE CHECK
    scope = _load_scope()
    zone = resolve_zone(file_path)
    perms = ZONE_PERMISSIONS.get(zone, ZONE_PERMISSIONS[FileZone.SOURCE])

    if zone == FileZone.SYSTEM:
        w_score, locked, _ = add_violation(f"system_zone: {file_path}", 100)
        if locked:
            _deny(f"locked after SYSTEM zone write (window={w_score})")
        _deny(f"SYSTEM zone blocked — {file_path} (window={w_score})")

    if zone == FileZone.RUNTIME and tool_name == "Edit":
        w_score, locked, _ = add_violation(f"runtime_overwrite: {file_path}", 60)
        if locked:
            _deny(f"locked after RUNTIME overwrite (window={w_score})")
        _deny(f"RUNTIME zone append-only — cannot overwrite {file_path} (window={w_score})")

    # 4. Scope 初始化检查 (v5.0: 给出明确指引)
    if not scope.get("task_id"):
        _deny(
            f"no scope initialized. "
            f"Run: python3 acs_lite.py init <task_id> <dir1,dir2,...> "
            f"[--shadow] [--proposal]"
        )

    # 5. SHADOW WALL
    if scope.get("shadow_mode", False) and not is_shadow_workspace(resolved):
        w_score, locked, _ = add_violation(f"shadow_violation: {file_path}", 40)
        if locked:
            _deny(f"locked after shadow violation (window={w_score})")
        _deny(f"shadow mode active — write to {SHADOW_ROOT}")

    # 6. PROPOSAL GATE (v5.0: acs_lite 为唯一决策中心)
    needs_proposal = scope.get("proposal_required", False) or _infer_proposal_from_path(file_path)
    if needs_proposal and not _check_proposal(file_path, tool_input):
        w_score, locked, _ = add_violation(f"no_proposal: {file_path}", 40)
        if locked:
            _deny(f"locked after proposal missing (window={w_score})")
        _deny(f"proposal required — submit via /proposal (window={w_score})")

    # 7. SCOPE 范围检查
    if not is_in_scope(resolved, scope):
        w_score, locked, _ = add_violation(f"out_of_scope: {file_path}", 40)
        if locked:
            _deny(f"locked after out_of_scope (window={w_score})")
        _deny(f"outside scope — {file_path} (window={w_score})")

    # v5.0 safety asserts
    HOME = Path.home().resolve()
    assert resolved.is_relative_to(HOME) or resolved.is_relative_to(Path("/tmp")), \
        f"[ACS v1.5.0] path escape detected: {resolved}"
    assert scope is not None, "[ACS v1.5.0] scope must exist at this point"

    # 8. STRUCTURAL VERIFIER
    if resolved.exists() and resolved.suffix in SUPPORTED_SUFFIXES:
        result = verify_structural_change(file_path, tool_name, tool_input)
        if not result["ok"]:
            reasons = "; ".join(f"{c[0]}: {c[1]}" for c in result.get("checks", []))
            w_score, locked, _ = add_violation(f"structural: {reasons}", 15)
            if locked:
                _deny(f"locked after structural violation (window={w_score})")
            _deny(f"structural integrity — {reasons} (window={w_score})")

    return {"allowed": True, "reason": "passed_all_checks"}



# ── v5.0 ACS Self-Protection ──────────────────────────────────────────────

ACS_SYSTEM_FILES = [
    Path.home() / ".claude" / "hooks",
    Path.home() / ".claude" / "runtime",           # v5.1: entire runtime/ (was: only LOCKED + VIOLATIONS)
    Path.home() / ".claude" / "settings.json",     # v5.2: hook config
    Path.home() / ".claude" / "settings.local.json",# v5.2: local overrides
    Path.home() / ".claude" / "CLAUDE.md",         # v5.2: constitution
    Path.home() / ".claude.json",                  # v5.2: global config
]

_ALWAYS_WRITE_VERB_RE = re.compile(r'(?:rm|mv|chmod|chown|truncate|dd|tee)\s')
_MAYBE_WRITE_VERB_RE = re.compile(r'(?:sed|awk|perl|python\S*)\s')
_REAL_REDIRECT_RE = re.compile(r'(?<!\d)>{1,2}(?!&)')
_INPLACE_FLAG_RE = re.compile(r'(?:^|\s)-\w*i\w*(?:\s|$)|--in-place\b')


def _looks_like_write(command: str) -> bool:
    """v5.4: sed/awk/perl/python are read-capable; only treat as a write
    attempt if there's an actual in-place flag or a real file redirect
    (2>&1-style fd duplication does not count)."""
    if _ALWAYS_WRITE_VERB_RE.search(command):
        return True
    if _MAYBE_WRITE_VERB_RE.search(command):
        return bool(_INPLACE_FLAG_RE.search(command) or _REAL_REDIRECT_RE.search(command))
    return bool(_REAL_REDIRECT_RE.search(command))


def _self_protect_bash(command: str) -> None:
    """Block any Bash operation targeting ACS system files."""
    if _looks_like_write(command):
        for p in ACS_SYSTEM_FILES:
            p_str = str(p)
            if p_str in command:
                _deny(f"ACS_SELF_PROTECT: cannot modify ACS system file: {p_str} (score=100)")
    # Also catch explicit targeting of ACS hooks via python
    if re.search(r'(?:Write|Edit|write|edit).*\.claude/hooks/', command):
        _deny(f"ACS_SELF_PROTECT: cannot modify ACS hooks directory (score=100)")
def check_bash(command: str) -> Dict:
    # 安全关键：解锁命令必须始终可用，即使系统已锁定
    cmd_stripped = command.strip()
    if "acs_lite.py unlock" in cmd_stripped:
        return {"allowed": True, "reason": "unlock_whitelist"}
    if "acs_lite.py reset" in cmd_stripped and "--force" in cmd_stripped:
        return {"allowed": True, "reason": "reset_force_whitelist"}

    # v5.0 self-protect: block Bash targeting ACS system files
    _self_protect_bash(command)

    _gate_lock()
    scope = _load_scope()

    # v5.0: 无 scope → baseline 白名单
    if not scope.get("task_id"):
        deny_reason = _check_baseline_command(command)
        if deny_reason:
            bl_score = 25
            w_score, locked, _ = add_violation(f"baseline_deny: {deny_reason}", bl_score)
            if locked:
                _deny(f"locked after baseline violation (window={w_score})")
            _deny(f"{deny_reason} (window={w_score})")
        return {"allowed": True, "reason": "baseline_only"}

    # v5.0: 研发模式下 EXEC 类别降级为警告 (_current_mode + RESEARCH_MODES are module-level now)

    # P2-3: load violations once, reuse for display and return value
    _v = load_violations()
    _ws_display = window_score(_v)

    # Zone-aware mass delete
    if is_mass_delete(command):
        w_score, locked, _ = add_violation("bash: mass_delete", 100)
        if locked:
            _deny(f"locked after mass delete (window={w_score})")
        _deny(f"[DELETE:MASS] {command[:120]} (window={w_score})")
        return {"allowed": False, "reason": "mass_delete", "violation": w_score}

    current_mode = _current_mode()
    # Strip quoted strings before pattern matching to prevent false positives
    _stripped = re.sub(r"'[^']*'", "''", command)
    _stripped = re.sub(r'"[^"\\]*(?:\\.[^"\\]*)*"', '""', _stripped)
    for pattern, desc in COMPILED_BASH:
        if pattern.search(_stripped):
            category = _classify_bash(desc)
            score = CATEGORY_SCORES.get(category, 25)

            # v5.0: 研发模式下 inline/heredoc interpreter 只警告不拦截
            if desc in ("inline interpreter", "heredoc interpreter") and current_mode in RESEARCH_MODES:
                print(
                    f"[ACS v1.5.0] WARNING: [{category}] {desc} — "
                    f"allowed in {current_mode} mode (window={_ws_display})",
                    file=sys.stderr
                )
                continue

            w_score, locked, _ = add_violation(f"bash[{category}]: {desc}", score)
            if locked:
                _deny(f"locked after dangerous bash (window={w_score})")
            _deny(f"[{category}] {desc} — {command[:120]} (window={w_score})")

            # v1.5.0: Asset-aware safety check
            
            _rm_match = re.search(r"\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)?(\S+)", command)
            if _rm_match and _asset_ledger.is_tracked(_rm_match.group(1)):
                _decision = _asset_ledger.is_safe_to_delete(_rm_match.group(1))
                if "BLOCK" in _decision:
                    w_score, locked, _ = add_violation(f"asset: {_decision}", 100)
                    if locked:
                        _deny(f"locked after asset violation (window={w_score})")
                    _deny(f"[ASSET:{_decision}] {command[:120]} (window={w_score})")


    # Scope blocked commands
    for pattern_str in scope.get("blocked_commands", []):
        if re.search(pattern_str, command, re.I):
            w_score, locked, _ = add_violation(f"scope_blocked: {pattern_str}", 40)
            if locked:
                _deny(f"locked after scope rule (window={w_score})")
            _deny(f"blocked by scope rule (window={w_score})")

    return {"allowed": True, "reason": "passed", "violation": _ws_display}


# ═════════════════════════════════════════════════════════════════════════
#  CLI 命令
# ═════════════════════════════════════════════════════════════════════════

def cmd_init(args: List[str]) -> None:
    if len(args) < 2:
        print("usage: acs_lite.py init <task_id> <dir1,dir2,...> [--shadow] [--proposal]")
        sys.exit(1)
    task_id = args[0]
    if not re.match(r"^[a-zA-Z0-9_-]{1,64}$", task_id):
        print(f"[ACS v1.5.0] ERROR: task_id must match [a-zA-Z0-9_-]{{1,64}}, got: {task_id!r}")
        sys.exit(1)

    allowed_dirs = [os.path.expanduser(d.strip()) for d in args[1].split(",") if d.strip()]
    extra = args[2:] if len(args) > 2 else []
    shadow = "--shadow" in extra
    proposal = "--proposal" in extra
    blocked = [c.strip() for c in extra if not c.startswith("--")]

    _active_task_write(task_id, allowed_dirs, blocked_commands=blocked,
                       shadow_mode=shadow, proposal_required=proposal)
    clear_violations(reason=f"scope_reinit:{task_id}")
    _budget_reset()
    integrity_store()

    print(f"[ACS v1.5.0] scope: {task_id} ({len(allowed_dirs)} dirs) "
          f"shadow={shadow} proposal={proposal}")
    print(f"[ACS v1.5.0] violations cleared, lock released, "
          f"budget reset, integrity baseline updated")


def cmd_status() -> None:
    a = _active_task_read()
    use_active = bool(a.get("task_id") and a["task_id"] != "(none)")
    s = a if use_active else _load_scope()
    source = "ACTIVE_TASK.json" if use_active else "TASK_SCOPE.json"

    v = load_violations()
    w_score = window_score(v)
    t_score = total_score(v)
    tid = s.get("task_id", "(none)")

    ts_str = "—"
    if s.get("created_at"):
        ts_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(s["created_at"]))
    elif s.get("updated_at"):
        ts_str = s["updated_at"]

    print(f"[ACS v1.5.0] task: {tid}  created: {ts_str}  (source: {source})")
    print(f"[ACS v1.5.0] dirs: {s.get('allowed_dirs', s.get('allowed_files', []))}")
    print(f"[ACS v1.5.0] shadow: {s.get('shadow_mode', False)} | "
          f"proposal: {s.get('proposal_required', False)}")
    print(f"[ACS v1.5.0] violations: window={w_score}/{WINDOW_THRESHOLD} "
          f"total={t_score}/{LOCK_DENY_SCORE}")
    print(f"[ACS v1.5.0] locked: {'YES ⚠' if LOCK_FILE.exists() else 'NO'}")
    print(f"[ACS v1.5.0] baseline_commands: {len(SCOPE_BASELINE_COMMANDS)} "
          f"readonly cmds allowed without scope")

    ok, tampered, missing, new = integrity_verify()
    stats = integrity_chain_stats()
    chain_len = stats.get("length", 0)
    if not ok:
        for t in tampered:
            print(f"[ACS v1.5.0]   TAMPERED: {t}")
        for m in missing:
            print(f"[ACS v1.5.0]   MISSING: {m}")
    else:
        chain_status = (f"chain ok ({chain_len} entries, hash verified)"
                        if stats.get("ok")
                        else f"CHAIN BROKEN ({stats.get('broken_count', 0)} broken entries "
                             f"at indices {stats.get('broken_indices', [])})")
        print(f"[ACS v1.5.0] INTEGRITY OK ({chain_status})")

    # === v5.0 新增: Token 预算状态 ===
    budget = _load_budget()
    b_inp = budget.get("total_input_tokens", 0)
    b_out = budget.get("total_output_tokens", 0)
    b_cost = budget.get("total_cost_usd", 0.0)
    b_model = budget.get("current_model", "?")
    b_sessions = budget.get("session_count", 0)
    print(f"[Token Budget] model={b_model}  inp={b_inp:,}  out={b_out:,}  "
          f"cost=${b_cost:.4f}  sessions={b_sessions}")

    # === v5.0 新增: 上下文状态 ===
    ctx = _load_context_state()
    print(f"[Context] rounds={ctx.get('rounds_since_compact', 0)}  "
          f"compact_due={'YES' if ctx.get('needs_compact') else 'no'}")

    # 违规记录尾部
    for e in v.get("events", [])[-5:]:
        sign = "+" if e["score"] >= 0 else ""
        print(f"  {sign}{e['score']:3d}  {e['reason']}")


def cmd_budget_report() -> None:
    """查看 Token 预算报告。"""
    report = _budget_get_report()
    print("=" * 60)
    print("  TOKEN BUDGET REPORT (v5.0)")
    print("=" * 60)
    print(f"  Total Input:    {report['total_input_tokens']:>12,} tokens")
    print(f"  Total Output:   {report['total_output_tokens']:>12,} tokens")
    print(f"  Combined:       {report['total_tokens']:>12,} tokens")
    print(f"  Total Cost:     ${report['total_cost_usd']:.4f}")
    print(f"  Current Model:  {report['current_model']}")
    print(f"  Sessions:       {report['sessions']}")

    if report["can_downgrade"]:
        print(f"  ↓ Can downgrade to: {report['degrade_to']} (saves cost)")

    # Token 进度条
    combined = report["total_tokens"]
    bar_len = 30
    if combined < TOKEN_SOFT_LIMIT:
        filled = int(combined / TOKEN_SOFT_LIMIT * bar_len)
        bar = "█" * filled + "░" * (bar_len - filled)
        pct = combined / TOKEN_SOFT_LIMIT * 100
        print(f"\n  Soft [{combined:,}/{TOKEN_SOFT_LIMIT:,}]: {bar} {pct:.0f}%")
    # elif combined < TOKEN_HARD_LIMIT:
    #     filled = int((combined - TOKEN_SOFT_LIMIT) /
    #                  (TOKEN_HARD_LIMIT - TOKEN_SOFT_LIMIT) * bar_len)
    #     bar = "█" * filled + "░" * (bar_len - filled)
    #     pct = (combined - TOKEN_SOFT_LIMIT) / (TOKEN_HARD_LIMIT - TOKEN_SOFT_LIMIT) * 100
    #     print(f"\n  Hard [{combined:,}/{TOKEN_HARD_LIMIT:,}]: {bar} {pct:.0f}% ⚠️")
    # else:
    #     print(f"\n  OVER LIMIT 🔴 ({combined:,} > {TOKEN_HARD_LIMIT:,})")
    #     print("  " + "█" * bar_len)

    print()


def cmd_reset(args: List[str]) -> None:
    if "--force" not in args:
        print("[ACS v1.5.0] ERROR: requires --force flag.")
        sys.exit(1)
    clear_violations(reason="manual_reset_force")
    _budget_reset()
    integrity_store()
    print("[ACS v1.5.0] violations cleared, budget reset, lock released, baseline updated")


def cmd_unlock() -> None:
    if LOCK_FILE.exists():
        try:
            LOCK_FILE.unlink()
        except FileNotFoundError:
            pass
        print("[ACS v1.5.0] lock cleared")
    else:
        print("[ACS v1.5.0] not locked")


def cmd_integrity_check() -> None:
    ok, tampered, missing, new = integrity_verify()
    if ok and not new:
        print("[ACS v1.5.0] INTEGRITY OK")
        chain_ok, broken = integrity_chain_verify()
        if chain_ok:
            print("[ACS v1.5.0] chain hash verification: OK")
        else:
            print(f"[ACS v1.5.0] chain hash verification: BROKEN "
                  f"({len(broken)} broken entries)")
        sys.exit(0)
    for t in tampered:
        print(f"  MODIFIED: {t}")
    for m in missing:
        print(f"  MISSING:  {m}")
    for n in new:
        print(f"  NEW:      {n}")
    sys.exit(1)


def cmd_chain_stats() -> None:
    stats = integrity_chain_stats()
    print(f"[ACS v1.5.0] chain length: {stats.get('length', 0)}")
    print(f"[ACS v1.5.0] first snapshot: {stats.get('first_snapshot', '?')}")
    print(f"[ACS v1.5.0] last snapshot:  {stats.get('last_snapshot', '?')}")
    print(f"[ACS v1.5.0] first ts: {stats.get('first_ts')}")
    print(f"[ACS v1.5.0] last ts:  {stats.get('last_ts')}")
    if stats.get("ok"):
        print("[ACS v1.5.0] chain hash: OK (rolling hash chain verified)")
    else:
        print(f"[ACS v1.5.0] chain hash: BROKEN "
              f"({stats.get('broken_count', 0)} broken entries)")


def cmd_chain_verify() -> None:
    ok, broken = integrity_chain_verify()
    if ok:
        print("[ACS v1.5.0] chain hash verification: OK (no tamper detected)")
        sys.exit(0)
    print(f"[ACS v1.5.0] chain hash verification: BROKEN ({len(broken)} broken entries)")
    for b in broken[:10]:
        print(f"  index {b.get('index')}: {b.get('reason')}")
        if "expected_hash" in b:
            print(f"    expected: {b['expected_hash']}")
            print(f"    actual:   {b['actual_hash']}")
    sys.exit(1)


def cmd_integrity_store() -> None:
    snap = integrity_store()
    print(f"[ACS v1.5.0] baseline stored: "
          f"{snap['snapshot_id'][:16]} (parent: {snap['parent']})")


# ═════════════════════════════════════════════════════════════════════════
#  Hook 入口 (v5.0 增强: 支持 context-prune + budget tracking)
# ═════════════════════════════════════════════════════════════════════════

def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool = data.get("tool_name", "")
    inp = data.get("tool_input", {})
    if not isinstance(inp, dict):
        sys.stderr.write("[ACS] Invalid tool_input type\n")
        sys.exit(2)

    # ---- 上下文裁剪检查 ----
    should_compact, warning = context_tick()
    if should_compact:
        msg = json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "warn",
                "permissionDecisionReason": warning
            }
        })
        sys.stderr.write(msg + "\n")

    # ---- Token budget 警告 ----
    budget = _load_budget()
    combined = budget.get("total_input_tokens", 0) + budget.get("total_output_tokens", 0)
    # [DISABLED by user request] TOKEN_HARD check
    # if TOKEN_SOFT_LIMIT <= combined < TOKEN_HARD_LIMIT:
    #     msg = json.dumps({
    #         "hookSpecificOutput": {
    #             "hookEventName": "PreToolUse",
    #             "permissionDecision": "warn",
    #             "permissionDecisionReason":
    #                 f"[ACS v1.5.0] TOKEN_SOFT: {combined:,}/{TOKEN_SOFT_LIMIT:,} — approaching limit"
    #         }
    #     })
    #     sys.stderr.write(msg + "\n")
    # [DISABLED by user request] TOKEN_HARD check
    # elif combined >= TOKEN_HARD_LIMIT:
    #     # 超过硬限制 → 建议开新会话
    #     msg = json.dumps({
    #         "hookSpecificOutput": {
    #             "hookEventName": "PreToolUse",
    #             "permissionDecision": "warn",
    #             "permissionDecisionReason":
    #                 f"[ACS v1.5.0] TOKEN_HARD: {combined:,} >= {TOKEN_HARD_LIMIT:,}. "
    #                 f"Open new session for continued work."
    #         }
    #     })
    #     sys.stderr.write(msg + "\n")

    # ---- 工具调用检查 ----
    if tool in ("Write", "Edit", "MultiEdit"):
        fp = inp.get("file_path", "")
        if fp:
            check_write(fp, tool, inp)

    elif tool == "Bash":
        cmd = inp.get("command", "")
        if cmd:
            result = check_bash(cmd)
            # v5.0: 记录执行成本
            if result.get("allowed"):
                budget_result = _budget_add_usage(0, len(cmd), model=budget.get("current_model"))
                action = budget_result[1]
                if action == "degrade":
                    print(f"[ACS v1.5.0] Auto-degrade: {budget.get('current_model')} → "
                          f"{budget_result[0].get('current_model')}", file=sys.stderr)

    elif tool == "Read":
        # v5.0: Read 不拦截，但记录 token 估算
        fp = inp.get("file_path", "")
        if fp:
            try:
                resolved = resolve(fp)
                if resolved.exists():
                    size = resolved.stat().st_size
                    est_tokens = max(size // 3, 100)
                    _budget_add_usage(est_tokens, 0, model=budget.get("current_model"))
            except Exception:
                pass

    # PostToolUse hook 可在此扩展
    # (proposal_guard, audit 等后续模块)


# ═════════════════════════════════════════════════════════════════════════
#  入口
# ═════════════════════════════════════════════════════════════════════════

_COMMANDS = {
    "init":              lambda: cmd_init(sys.argv[2:]),
    "status":            cmd_status,
    "reset":             lambda: cmd_reset(sys.argv[2:]),
    "unlock":            cmd_unlock,
    "budget-report":     cmd_budget_report,
    "compact-ack":       lambda: (context_compact_done(),
                                   print("[ACS v1.5.0] compact acknowledged")),
    "integrity-check":   cmd_integrity_check,
    "integrity-store":   cmd_integrity_store,
    "chain-stats":       cmd_chain_stats,
    "chain-verify":      cmd_chain_verify,
}

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in _COMMANDS:
        _COMMANDS[sys.argv[1]]()
    elif len(sys.argv) > 1:
        print(f"usage: acs_lite.py [{' | '.join(_COMMANDS.keys())}]",
              file=sys.stderr)
        sys.exit(1)
    else:
        main()