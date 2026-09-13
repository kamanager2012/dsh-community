#!/usr/bin/env python3
"""
acs_lite.py — ACS v1.2.0 主入口

v1.2.0 变更 (2026-06-05 控制流重构):
  P0-1   proposal_guard 移至 PostToolUse，acs_lite 为唯一 PreToolUse 决策中心
  P0-1b  proposal gate 加 _infer_from_path fallback (open-world 模型)
  P0-2   clear_violations 真重置 (events=[] + genesis baseline)
  Safety  3 行 assert (path escape / scope / chain)
  #3     研发模式下 python3 -c 降级为警告不拦截

v1.1.0 修复总览:
  C-1  self-deadlock: SCOPE_BASELINE 白名单
  C-2  Read secret 泄露: read_guard.py 处理
  C-3  PROPOSAL 路径错位: 统一到 audit/proposals.jsonl
  C-4  11 个孤儿 .py: 集成
  H-1  Violation 衰减: 滑动窗口
  H-2  LOCK 写入一致性
  H-7  统一 deny reason
"""
from __future__ import annotations

import datetime
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# v1.1.0: 模块化拆分
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
from acs_structural import verify_structural_change, SUPPORTED_SUFFIXES

# ── v1.1.0 Baseline: 无 scope 时仍可执行的只读命令（修 C-1 self-deadlock） ──
SCOPE_BASELINE_COMMANDS = frozenset({
    # POSIX 标准只读命令
    "ls", "cat", "find", "grep", "head", "tail", "wc", "pwd", "echo",
    "env", "stat", "file", "which", "whoami", "id", "date", "tree",
    "du", "df", "free", "ps", "uname", "printenv", "nl", "cut", "tr",
    "sort", "uniq", "comm", "diff", "od", "mkdir", "touch", "jq",
    # git 只读子命令
    "git",  # 由 git_guard 子正则限定只读子命令
    # python 只读子命令（-c 不允许；-V / --version / -h 允许）
    "python", "python3", "node",  # 走 bash_baseline 二次过滤
})

# v1.1.0: 这些危险模式即使在 baseline 也禁止
BASELINE_DENY_PATTERNS = [
    (r">\s*\S+",                          "redirect (write attempt)"),
    (r"\|\s*(?:sh|bash)\b",                "pipe to shell"),
    (r"\brm\s+",                           "rm command"),
    (r"\bchmod\s+",                        "chmod"),
    (r"\bchown\s+",                        "chown"),
    (r"\bsudo\b",                          "sudo"),
    (r"\bsu\s+",                           "su"),
    (r"\bmkfs\b",                          "mkfs"),
    (r"\bdd\s+",                           "dd"),
    (r"\bmount\b",                         "mount"),
    (r"\bumount\b",                        "umount"),
    (r"\bsystemctl\b",                     "systemctl"),
    (r"\bapt(-get)?\b",                    "apt"),
    (r"\bnpm\s+install\b",                 "npm install"),
    (r"--force|--hard|-rf\b",              "force/hard flag"),
    (r"\b(?:node|python3?|perl|ruby|php|lua)\s+-[ce]\b", "inline interpreter (no scope)"),
    (r"\b(?:python3?|node|perl|ruby|bash)\s+<<",         "heredoc interpreter (no scope)"),
]
BASELINE_DENY_COMPILED = [(re.compile(p, re.I), desc) for p, desc in BASELINE_DENY_PATTERNS]

# v1.1.0: secret 路径脱敏（修 C-2）
SENSITIVE_PATH_PATTERNS = [
    r".*\.claude/settings\.json$",
    r".*\.claude/settings\.local\.json$",
    r".*\.env$",
    r".*\.env\..+$",
]
SENSITIVE_PATH_COMPILED = [re.compile(p, re.I) for p in SENSITIVE_PATH_PATTERNS]

# ── 危险 Bash 模式（合并 v0.3.x self-protection + guard.py）─────────────────
DANGEROUS_BASH: List[Tuple[str, str]] = [
    # ── DELETE: 文件/目录删除 (60') ──
    (r"(?:^|[|;&]\s*)rm\s+-[a-zA-Z]*[rf]\s+/(?:\s|$)",          "rm -rf /"),
    (r"(?:^|[|;&]\s*)rm\s+-[a-zA-Z]*[rf]\s+\*",                 "rm -rf *"),
    (r"(?:^|[|;&]\s*)rm\s+-[a-zA-Z]*[rf]\s+~",                   "rm -rf ~"),
    (r"(?:^|[|;&]\s*)rm\s+-[a-zA-Z]*[rf]\s+\S*PROJ",           "rm -rf project"),
    (r"(?:^|[|;&]\s*)rm\s+\S+",                                   "rm file"),
    (r"\btruncate\s+-s\s+0",                                       "truncate to zero"),

    # ── WRITE: 文件内容修改 (25') ──
    (r"\bchmod\s+777\b",                                           "chmod 777"),
    (r"\bchown\s+root\b",                                          "chown root"),
    (r">\s*/etc/",                                                    "overwrite system file"),
    (r"\bhistory\s+-[cw]\b",                                       "clear shell history"),
    (r"\bunset\s+HISTFILE\b",                                      "disable shell history"),

    # ── EXEC: 代码执行 (10') ──
    (r"\b(?:node|python3?|perl|ruby|php|lua)\s+-[ce]\b",         "inline interpreter"),
    (r"\b(?:python3?|node|perl|ruby|bash)\s+<<",                   "heredoc interpreter"),

    # ── SYSTEM: 系统级破坏 (100') ──
    (r"(?:^|[|;&]\s*)mkfs\.",                                       "mkfs"),
    (r"(?:^|[|;&]\s*)dd\s+if=/dev/",                               "dd to block device"),
    (r"\breboot\b",                                                  "reboot"),
    (r"\bshutdown\b",                                                "shutdown"),
    (r":\(\s*\)\s*\{",                                            "fork bomb"),
    (r"\bcat\s+/etc/(?:shadow|passwd)\b",                          "read /etc sensitive"),

    # ── NETWORK: 外部依赖/远程变更 (60') ──
    (r"\b(?:wget|curl)\b.*\|\s*(?:sh|bash)\b",                 "download pipe shell"),
    (r"\bgit\s+push\s+--force\b",                                 "git push --force"),
    (r"\bgit\s+reset\s+--hard\b",                                 "git hard reset"),

    # ── ACS_SELF: 自保护 (100') ──
    (r"\bchmod\s+.*-[a-z]*x[a-z]*.*acs_lite",                      "chmod -x on ACS engine"),
    (r"\b(?:pip3?|pip)\s+install\b",                              "pip install"),
    (r"(?:cat|tee|dd|cp|mv)\s+.*>\s*\S*acs_lite\.py",          "ACS tamper: engine"),
    (r"(?:cat|tee|dd|cp|mv)\s+.*>\s*\S*acs_paths\.py",          "ACS tamper: paths"),
    (r"(?:cat|tee|dd|cp|mv)\s+.*>\s*\S*acs_violations\.py",     "ACS tamper: violations"),
    (r"(?:cat|tee|dd|cp|mv)\s+.*>\s*\S*acs_structural\.py",    "ACS tamper: structural"),
    (r"(?:cat|tee|dd)\s+.*>\s*\S*\.claude/hooks/",              "ACS tamper: hooks dir"),
    (r"(?:cat|tee|dd)\s+.*>\s*\S*\.claude/runtime/",            "ACS tamper: runtime dir"),
    (r"(?:cat|tee|dd)\s+.*>\s*\S*\.claude/settings\.json",     "ACS tamper: settings"),
    (r"python3?\s+\S*acs_lite\.py\s+reset\b",                   "ACS tamper: reset"),
    (r"rm\s+\S*\.claude/(hooks|runtime|governance|memory|audit)","ACS tamper: delete"),
    (r"sed\s+-i.*\.claude/(hooks|runtime|governance|memory)",     "ACS tamper: sed"),
]

# ── 行为分类映射表 (不动 DANGEROUS_BASH 结构) ──
CATEGORY_MAP = {
    # DELETE
    "rm -rf /":             "DELETE",   "rm -rf *":             "DELETE",
    "rm -rf ~":             "DELETE",   "rm -rf project":       "DELETE",
    "rm file":              "DELETE",   "truncate to zero":     "DELETE",
    # WRITE
    "chmod 777":            "WRITE",    "chown root":           "WRITE",
    "overwrite system file":"WRITE",    "clear shell history":  "WRITE",
    "disable shell history":"WRITE",
    # EXEC
    "inline interpreter":   "EXEC",     "heredoc interpreter":  "EXEC",
    # SYSTEM
    "mkfs":                 "SYSTEM",   "dd to block device":  "SYSTEM",
    "reboot":               "SYSTEM",   "shutdown":            "SYSTEM",
    "fork bomb":            "SYSTEM",   "read /etc sensitive":  "SYSTEM",
    # NETWORK
    "download pipe shell":  "NETWORK",  "git push --force":     "NETWORK",
    "git hard reset":       "NETWORK",
    # ACS_SELF
    "chmod -x on ACS engine":"ACS_SELF","pip install":          "ACS_SELF",
    "npm global install":   "ACS_SELF", "ACS tamper: engine":   "ACS_SELF",
    "ACS tamper: paths":    "ACS_SELF", "ACS tamper: violations":"ACS_SELF",
    "ACS tamper: structural":"ACS_SELF","ACS tamper: hooks dir":"ACS_SELF",
    "ACS tamper: runtime dir":"ACS_SELF","ACS tamper: settings":"ACS_SELF",
    "ACS tamper: reset":    "ACS_SELF", "ACS tamper: delete":   "ACS_SELF",
    "ACS tamper: sed":      "ACS_SELF",
}

CATEGORY_SCORES = {
    "EXEC":     10,   # 运行代码      — 4次才锁 (10×4=40<80)
    "WRITE":    25,   # 修改数据      — 3次才锁 (25×3=75<80)
    "DELETE":   60,   # 删除结构      — 1次近锁 (60+25=85>80)
    "SYSTEM":   100,  # 系统破坏      — 秒锁
    "NETWORK":  60,   # 外部/远程     — 1次近锁
    "ACS_SELF": 100,  # ACS 自保护    — 秒锁
}
DEFAULT_CATEGORY = "WRITE"  # 未匹配 → WRITE 级 (25')


# ── 行为分类映射表 (不动 DANGEROUS_BASH 结构) ──
CATEGORY_MAP = {
    # DELETE
    "rm -rf /":             "DELETE",   "rm -rf *":             "DELETE",
    "rm -rf ~":             "DELETE",   "rm -rf project":       "DELETE",
    "rm file":              "DELETE",   "truncate to zero":     "DELETE",
    # WRITE
    "chmod 777":            "WRITE",    "chown root":           "WRITE",
    "overwrite system file":"WRITE",    "clear shell history":  "WRITE",
    "disable shell history":"WRITE",
    # EXEC
    "inline interpreter":   "EXEC",     "heredoc interpreter":  "EXEC",
    # SYSTEM
    "mkfs":                 "SYSTEM",   "dd to block device":  "SYSTEM",
    "reboot":               "SYSTEM",   "shutdown":            "SYSTEM",
    "fork bomb":            "SYSTEM",   "read /etc sensitive":  "SYSTEM",
    # NETWORK
    "download pipe shell":  "NETWORK",  "git push --force":     "NETWORK",
    "git hard reset":       "NETWORK",
    # ACS_SELF
    "chmod -x on ACS engine":"ACS_SELF","pip install":          "ACS_SELF",
    "npm global install":   "ACS_SELF", "ACS tamper: engine":   "ACS_SELF",
    "ACS tamper: paths":    "ACS_SELF", "ACS tamper: violations":"ACS_SELF",
    "ACS tamper: structural":"ACS_SELF","ACS tamper: hooks dir":"ACS_SELF",
    "ACS tamper: runtime dir":"ACS_SELF","ACS tamper: settings":"ACS_SELF",
    "ACS tamper: reset":    "ACS_SELF", "ACS tamper: delete":   "ACS_SELF",
    "ACS tamper: sed":      "ACS_SELF",
}

CATEGORY_SCORES = {
    "EXEC":     10,   # 运行代码      — 4次才锁 (10×4=40<80)
    "WRITE":    25,   # 修改数据      — 3次才锁 (25×3=75<80)
    "DELETE":   60,   # 删除结构      — 1次近锁 (60+25=85>80)
    "SYSTEM":   100,  # 系统破坏      — 秒锁
    "NETWORK":  60,   # 外部/远程     — 1次近锁
    "ACS_SELF": 100,  # ACS 自保护    — 秒锁
}
DEFAULT_CATEGORY = "WRITE"  # 未匹配 → WRITE 级 (25')


COMPILED_BASH: List[Tuple[re.Pattern, str]] = [(re.compile(p, re.I), desc) for p, desc in DANGEROUS_BASH]

# ── v4.5 风险分级分数表（附在 DANGEROUS_BASH 之后）────────────────────
# 不改 DANGEROUS_BASH 结构，check_bash 通过 desc 查分


# DANGEROUS_GLOB moved to filesystem_guard (v4.5 single owner)


# ═════════════════════════════════════════════════════════════════════════
# 工具函数
# ═════════════════════════════════════════════════════════════════════════

def _active_task_read() -> Dict:
    try:
        if ACTIVE_TASK_FILE.exists():
            return json.loads(ACTIVE_TASK_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def _active_task_write(
    task_id: str,
    allowed_dirs: List[str],
    allowed_files: Optional[List[str]] = None,
    blocked_commands: Optional[List[str]] = None,
    shadow_mode: bool = False,
    proposal_required: bool = False,
) -> None:
    doc = {
        "version": "4.5", "task": task_id, "task_id": task_id,
        "status": "ACTIVE", "allowed_dirs": allowed_dirs,
        "allowed_files": allowed_files if allowed_files is not None else allowed_dirs,
        "blocked_commands": blocked_commands or [],
        "shadow_mode": shadow_mode,
        "proposal_required": proposal_required,
        "updated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    # v1.1.0: 同步更新 SCOPE_FILE 避免状态分叉
    SCOPE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(SCOPE_FILE, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
    with open(ACTIVE_TASK_FILE, "w") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)


def _deny(reason: str) -> None:
    """v1.2.0 统一 deny 出口。"""
    payload = json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"[ACS v1.2.0] BLOCKED: {reason}",
        }
    })
    sys.stderr.write(payload + "\n")
    sys.exit(2)


# v1.1.0 修: session memory/journal 反馈通道豁免
# 路径: ~/.claude/projects/<session>/(memory|journal)/...
# 理由: 这是 Claude 的反馈通道，必须能写入；projects audit/governance 仍受 PROTECTED 保护
SESSION_FEEDBACK_RE = re.compile(
    r".*/\.claude/projects/[^/]+/(memory|journal)(/.*)?$"
)

def is_session_feedback(path_str: str) -> bool:
    return bool(SESSION_FEEDBACK_RE.match(path_str))


def _gate_lock() -> None:
    """v1.1.0 修复 H-2: 锁定时直接 deny。"""
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


def _check_baseline_command(command: str) -> Optional[str]:
    """v1.1.0 修 C-1: 无 scope 时检查是否是 baseline 只读命令。返回 deny 原因或 None。"""
    # 先检查 baseline 永远禁止的模式
    for pattern, desc in BASELINE_DENY_COMPILED:
        if pattern.search(command):
            return f"baseline_deny: {desc}"

    # 解析第一个 token
    parts = command.strip().split(None, 1)
    if not parts:
        return None
    exe = Path(parts[0]).name
    if exe not in SCOPE_BASELINE_COMMANDS:
        return f"not in baseline: {exe} (no scope initialized)"

    # git 二次过滤：只允许只读子命令
    if exe == "git":
        git_subcommands = {"status", "log", "diff", "show", "branch", "tag", "remote", "config", "rev-parse", "ls-files", "ls-tree", "cat-file", "blame", "shortlog", "describe", "stash", "stash list", "reflog"}
        git_args = parts[1] if len(parts) > 1 else ""
        first_git = git_args.strip().split(None, 1)[0] if git_args.strip() else ""
        if first_git not in git_subcommands:
            return f"git {first_git} not in baseline (no scope)"

    return None


# ═════════════════════════════════════════════════════════════════════════
# 检查入口
# ═════════════════════════════════════════════════════════════════════════

def check_write(file_path: str, tool_name: str, tool_input: Dict) -> Dict:
    resolved = resolve(file_path)
    scope = _load_scope()

    _gate_lock()

    # 0. v1.1.0 反馈通道豁免: session memory/journal 必须能写入
    if is_session_feedback(file_path):
        return {"allowed": True, "reason": "session_feedback"}

    # 1. PROTECTED（始终 deny，不受 scope 影响）
    if is_protected(resolved):
        w_score, locked, _ = add_violation(f"protected_path: {file_path}", 100)
        if locked:
            _deny(f"locked after protected_path attempt: {file_path} (window={w_score})")
        _deny(f"protected path — {file_path} (window={w_score})")

    # 2. ALWAYS_WRITABLE / SHADOW 直接放行
    if is_always_writable(resolved) or is_shadow_workspace(resolved):
        return {"allowed": True, "reason": "always_writable_or_shadow"}

    # 3. ZONE CHECK (v4.5 Workspace Governance)
    zone = resolve_zone(file_path)
    perms = ZONE_PERMISSIONS.get(zone, ZONE_PERMISSIONS[FileZone.SOURCE])

    if zone == FileZone.SYSTEM:
        w_score, locked, _ = add_violation(f"system_zone: {file_path}", 100)
        if locked:
            _deny(f"locked after SYSTEM zone write attempt (window={w_score})")
        _deny(f"SYSTEM zone blocked — {file_path} (window={w_score})")

    if zone == FileZone.RUNTIME and tool_name == "Edit":
        # RUNTIME is append-only: Write (create) ok, Edit (overwrite) denied
        w_score, locked, _ = add_violation(f"runtime_overwrite: {file_path}", 60)
        if locked:
            _deny(f"locked after RUNTIME overwrite (window={w_score})")
        _deny(f"RUNTIME zone append-only — cannot overwrite {file_path} (window={w_score})")

    # 3a. SCOPE 检查（v1.1.0 fail-closed）
    if not scope.get("task_id"):
        # v1.1.0 修 C-1: 给出清晰的 init 指引
        _deny(f"no scope initialized. Run: python3 acs_lite.py init <task_id> <dir1,dir2>")

    # 4. SHADOW WALL
    if scope.get("shadow_mode", False) and not is_shadow_workspace(resolved):
        w_score, locked, _ = add_violation(f"shadow_violation: {file_path}", 40)
        if locked:
            _deny(f"locked after shadow violation (window={w_score})")
        _deny(f"shadow mode active — write to {SHADOW_ROOT}")

    # 5. PROPOSAL GATE (v1.2.0: acs_lite 是唯一决策中心, proposal_guard 已移至 PostToolUse 纯审计)
    # scope.proposal_required 显式控制 + infer_from_path 路径推断 fallback
    needs_proposal = scope.get("proposal_required", False) or _infer_proposal_from_path(file_path)
    if needs_proposal and not _check_proposal(file_path, tool_input):
        w_score, locked, _ = add_violation(f"no_proposal: {file_path}", 40)
        if locked:
            _deny(f"locked after proposal missing (window={w_score})")
        _deny(f"proposal required — submit via /proposal (window={w_score})")

    # 6. SCOPE 范围检查
    if not is_in_scope(resolved, scope):
        w_score, locked, _ = add_violation(f"out_of_scope: {file_path}", 40)
        if locked:
            _deny(f"locked after out_of_scope (window={w_score})")
        _deny(f"outside scope — {file_path} (window={w_score})")

    # v1.2.0 safety asserts — 状态一致性检查，不阻止正常流程
    HOME = Path.home().resolve()
    assert resolved.is_relative_to(HOME) or resolved.is_relative_to(Path("/tmp")), \
        f"[ACS v1.2.0] path escape detected: {resolved}"
    assert scope is not None, "[ACS v1.2.0] scope must exist at this point"

    # 7. STRUCTURAL VERIFIER
    if resolved.exists() and resolved.suffix in SUPPORTED_SUFFIXES:
        result = verify_structural_change(file_path, tool_name, tool_input)
        if not result["ok"]:
            reasons = "; ".join(f"{c[0]}: {c[1]}" for c in result.get("checks", []))
            w_score, locked, _ = add_violation(f"structural: {reasons}", 15)
            if locked:
                _deny(f"locked after structural violation (window={w_score})")
            _deny(f"structural integrity — {reasons} (window={w_score})")

    return {"allowed": True, "reason": "passed_all_checks"}


def check_bash(command: str) -> Dict:
    _gate_lock()
    scope = _load_scope()

    # v1.1.0 修 C-1: 无 scope 时尝试 baseline 白名单
    if not scope.get("task_id"):
        deny_reason = _check_baseline_command(command)
        if deny_reason:
            bl_score = 25  # WRITE-level default for baseline
            w_score, locked, _ = add_violation(f"baseline_deny: {deny_reason}", bl_score)
            if locked:
                _deny(f"locked after baseline violation (window={w_score})")
            _deny(f"{deny_reason} (window={w_score})")
        # baseline 通过 → 放行
        return {"allowed": True, "reason": "baseline_only"}

    # v1.2.0 #3: 研发模式下 EXEC 类别降级为警告不拦截
    # python3 -c / node -e 等内联解释器在研发模式 (ACTIVE/RESEARCH) 下是合理的
    # 其他 EXEC (heredoc interpreter) 仍然拦截
    MODE_FILE = RUNTIME_DIR / "MODE.json"
    RESEARCH_MODES = {"ACTIVE", "RESEARCH"}

    def _current_mode():
        try:
            if MODE_FILE.exists():
                data = json.loads(MODE_FILE.read_text())
                return data.get("mode", "UNKNOWN")
        except (OSError, json.JSONDecodeError):
            pass
        return "UNKNOWN"

    # 有 scope: 分类评分（行为语义模型）
    # Zone-aware mass delete check
    if is_mass_delete(command):
        w_score, locked, _ = add_violation(f"bash: mass_delete", 100)
        if locked:
            _deny(f"locked after mass delete (window={w_score})")
        _deny(f"[DELETE:MASS] {command[:120]} (window={w_score})")

    current_mode = _current_mode()
    for pattern, desc in COMPILED_BASH:
        if pattern.search(command):
            category = CATEGORY_MAP.get(desc, DEFAULT_CATEGORY)
            score = CATEGORY_SCORES.get(category, 25)

            # v1.2.0 #3: 研发模式下 inline/heredoc interpreter 只警告不拦截
            if desc in ("inline interpreter", "heredoc interpreter") and current_mode in RESEARCH_MODES:
                print(f"[ACS v1.2.0] WARNING: [{category}] {desc} — allowed in {current_mode} mode (window={window_score(load_violations())})", file=sys.stderr)
                continue  # 记录但不拦截

            w_score, locked, _ = add_violation(f"bash[{category}]: {desc}", score)
            if locked:
                _deny(f"locked after dangerous bash (window={w_score})")
            _deny(f"[{category}] {desc} — {command[:120]} (window={w_score})")

    for pattern_str in scope.get("blocked_commands", []):
        if re.search(pattern_str, command, re.I):
            w_score, locked, _ = add_violation(f"scope_blocked: {pattern_str}", 40)
            if locked:
                _deny(f"locked after scope rule (window={w_score})")
            _deny(f"blocked by scope rule (window={w_score})")

    return {"allowed": True, "reason": "passed", "violation": window_score(load_violations())}


def _load_scope() -> Dict:
    try:
        if SCOPE_FILE.exists():
            return json.loads(SCOPE_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {}


def _infer_proposal_from_path(file_path: str) -> bool:
    """v1.2.0 P0-1b: 路径推断 — 当 scope 未显式设 proposal_required 时，
    从文件路径推断是否需要 proposal。

    open-world 模型: 已知安全路径不需要, 其他默认需要。
    与 proposal_guard.py 的 ALLOWED_PREFIXES 保持一致。
    """
    HOME = Path.home().resolve()
    resolved = Path(file_path).resolve() if file_path else Path()

    # v1.2.0 safety assert: path 不逃出 HOME（/tmp 例外）
    if not (resolved.is_relative_to(HOME) or resolved.is_relative_to(Path("/tmp"))):
        return True  # 逃出 HOME → 需要 proposal

    ALLOWED_PREFIXES = [
        HOME / ".claude" / "runtime",
        HOME / ".claude" / "audit",
        HOME / ".claude" / "snapshots",
        HOME / ".claude" / "governance",
        HOME / ".claude" / "hooks",
        HOME / "agent-constraint-system",
        HOME / "my-project",
        Path("/tmp/claude-shadow"),
        Path("/tmp"),
    ]
    for prefix in ALLOWED_PREFIXES:
        if resolved == prefix or resolved.is_relative_to(prefix):
            return False  # 在允许路径内 → 不需要 proposal
    return True  # 其余路径默认需要 proposal


def _check_proposal(file_path: str, tool_input: Dict) -> bool:
    """v1.1.0 修 C-3: PROPOSAL_FILE 路径已统一到 audit/proposals.jsonl"""
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
# CLI 命令
# ═════════════════════════════════════════════════════════════════════════

def cmd_init(args: List[str]) -> None:
    if len(args) < 2:
        print("usage: acs_lite.py init <task_id> <dir1,dir2,...> [--shadow] [--proposal] [blocked_cmd_regex,...]")
        sys.exit(1)
    task_id = args[0]
    # v1.1.0 修 M-5: task_id 校验
    if not re.match(r"^[a-zA-Z0-9_-]{1,64}$", task_id):
        print(f"[ACS v1.2.0] ERROR: task_id must match [a-zA-Z0-9_-]{{1,64}}, got: {task_id!r}")
        sys.exit(1)
    allowed_dirs = [d.strip() for d in args[1].split(",") if d.strip()]
    extra = args[2:] if len(args) > 2 else []
    shadow = "--shadow" in extra
    proposal = "--proposal" in extra
    blocked = [c.strip() for c in extra if not c.startswith("--")]

    _active_task_write(task_id, allowed_dirs, blocked_commands=blocked,
                       shadow_mode=shadow, proposal_required=proposal)
    clear_violations(reason=f"scope_reinit:{task_id}")
    integrity_store()
    print(f"[ACS v1.2.0] scope: {task_id} ({len(allowed_dirs)} dirs) shadow={shadow} proposal={proposal}")
    print(f"[ACS v1.2.0] violations cleared, lock released, integrity baseline updated")


def cmd_status() -> None:
    a = _active_task_read()
    use_active = bool(a.get("task_id") and a["task_id"] != "(none)")
    s = a if use_active else _load_scope()
    source = "ACTIVE_TASK.json" if use_active else "TASK_SCOPE.json"

    v = load_violations()
    w_score = window_score(v)
    t_score = total_score(v)
    tid = s.get("task_id", "(none)")

    if s.get("created_at"):
        ts_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(s["created_at"]))
    elif s.get("updated_at"):
        ts_str = s["updated_at"]
    else:
        ts_str = "—"

    print(f"[ACS v1.2.0] task: {tid}  created: {ts_str}  (source: {source})")
    print(f"[ACS v1.2.0] dirs: {s.get('allowed_dirs', s.get('allowed_files', []))}")
    print(f"[ACS v1.2.0] shadow: {s.get('shadow_mode', False)} | proposal: {s.get('proposal_required', False)}")
    print(f"[ACS v1.2.0] violations: window={w_score}/{WINDOW_THRESHOLD} total={t_score}/{LOCK_DENY_SCORE}")
    print(f"[ACS v1.2.0] locked: {'YES ⚠' if LOCK_FILE.exists() else 'NO'}")
    print(f"[ACS v1.2.0] baseline_commands: {len(SCOPE_BASELINE_COMMANDS)} readonly cmds allowed without scope")

    ok, tampered, missing, new = integrity_verify()
    stats = integrity_chain_stats()
    entries_file = INTEGRITY_FILE
    chain_len = stats.get("length", 0)
    if not ok:
        for t in tampered:
            print(f"[ACS v1.2.0]   TAMPERED: {t}")
        for m in missing:
            print(f"[ACS v1.2.0]   MISSING: {m}")
    else:
        chain_status = f"chain ok ({chain_len} entries, hash verified)" if stats.get("ok") else \
                       f"CHAIN BROKEN ({stats.get('broken_count', 0)} broken entries at indices {stats.get('broken_indices', [])})"
        print(f"[ACS v1.2.0] INTEGRITY OK ({chain_status})")


def cmd_reset(args: List[str]) -> None:
    if "--force" not in args:
        print("[ACS v1.2.0] ERROR: requires --force flag.")
        sys.exit(1)
    clear_violations(reason="manual_reset_force")
    integrity_store()
    print("[ACS v1.2.0] violations cleared, lock released, integrity baseline updated")


def cmd_unlock() -> None:
    if LOCK_FILE.exists():
        try:
            LOCK_FILE.unlink()
        except FileNotFoundError:
            pass
        print("[ACS v1.2.0] lock cleared")
    else:
        print("[ACS v1.2.0] not locked")


def cmd_integrity_check() -> None:
    ok, tampered, missing, new = integrity_verify()
    if ok and not new:
        print("[ACS v1.2.0] INTEGRITY OK")
        # v1.1.0 H-8: 顺便验证整个 chain
        chain_ok, broken = integrity_chain_verify()
        if chain_ok:
            print("[ACS v1.2.0] chain hash verification: OK")
        else:
            print(f"[ACS v1.2.0] chain hash verification: BROKEN ({len(broken)} broken entries)")
            for b in broken[:3]:
                print(f"  index {b.get('index')}: {b.get('reason')} - {b.get('snapshot_id', '?')[:16]}")
        sys.exit(0)
    for t in tampered:
        print(f"  MODIFIED: {t}")
    for m in missing:
        print(f"  MISSING:  {m}")
    for n in new:
        print(f"  NEW:      {n}")
    sys.exit(1)


def cmd_chain_stats() -> None:
    """v1.1.0 H-8 新增: 显示 chain 统计信息。"""
    stats = integrity_chain_stats()
    print(f"[ACS v1.2.0] chain length: {stats.get('length', 0)}")
    print(f"[ACS v1.2.0] first snapshot: {stats.get('first_snapshot', '?')}")
    print(f"[ACS v1.2.0] last snapshot:  {stats.get('last_snapshot', '?')}")
    print(f"[ACS v1.2.0] first ts: {stats.get('first_ts')}")
    print(f"[ACS v1.2.0] last ts:  {stats.get('last_ts')}")
    if stats.get("ok"):
        print("[ACS v1.2.0] chain hash: OK (rolling hash chain verified)")
    else:
        print(f"[ACS v1.2.0] chain hash: BROKEN ({stats.get('broken_count', 0)} broken entries)")
        for idx in stats.get("broken_indices", []):
            print(f"  broken at index {idx}")


def cmd_chain_verify() -> None:
    """v1.1.0 H-8 新增: 验证整个 chain 完整性。"""
    ok, broken = integrity_chain_verify()
    if ok:
        print("[ACS v1.2.0] chain hash verification: OK (no tamper detected)")
        sys.exit(0)
    print(f"[ACS v1.2.0] chain hash verification: BROKEN ({len(broken)} broken entries)")
    for b in broken[:10]:
        print(f"  index {b.get('index')}: {b.get('reason')}")
        if "expected_hash" in b:
            print(f"    expected: {b['expected_hash']}")
            print(f"    actual:   {b['actual_hash']}")
    sys.exit(1)


def cmd_integrity_store() -> None:
    """v1.1.0 新增：手动 store baseline（部署后/文件替换后用）。"""
    snap = integrity_store()
    print(f"[ACS v1.2.0] baseline stored: {snap['snapshot_id'][:16]} (parent: {snap['parent']})")


# ═════════════════════════════════════════════════════════════════════════
# Hook 入口
# ═════════════════════════════════════════════════════════════════════════

def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool = data.get("tool_name", "")
    inp = data.get("tool_input", {})

    if tool in ("Write", "Edit", "MultiEdit"):
        fp = inp.get("file_path", "")
        if fp:
            check_write(fp, tool, inp)
    elif tool == "Bash":
        cmd = inp.get("command", "")
        if cmd:
            check_bash(cmd)
    else:
        sys.exit(0)


_COMMANDS = {
    "init":              lambda: cmd_init(sys.argv[2:]),
    "status":            cmd_status,
    "reset":             lambda: cmd_reset(sys.argv[2:]),
    "unlock":            cmd_unlock,
    "integrity-check":   cmd_integrity_check,
    "integrity-store":   cmd_integrity_store,
    "chain-stats":       cmd_chain_stats,
    "chain-verify":      cmd_chain_verify,
}


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] in _COMMANDS:
        _COMMANDS[sys.argv[1]]()
    elif len(sys.argv) > 1:
        print(f"usage: acs_lite.py [{' | '.join(_COMMANDS)}]", file=sys.stderr)
        sys.exit(1)
    else:
        main()
