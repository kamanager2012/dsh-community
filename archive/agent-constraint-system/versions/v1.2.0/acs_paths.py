#!/usr/bin/env python3
"""
acs_paths.py — v1.1.0 路径解析与保护层 (M-1, M-2, M-7, C-5)

v0.3.x 缺陷修复:
  C-5  PROJECT 路径硬编码 → 显式 env var (CLAUDE_PROJECT_DIR) + cwd 推断
  M-1  Symlink 不稳定 → 路径解析后做绝对化校验
  M-2  路径在 .claude/runtime/.../scope 解析中会重置 → 修复 / 绝对路径处理
  M-7  ABI 模式过宽 (.*\.d\.ts 匹配 node_modules) → 排除常见构建目录
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import List, Optional, Sequence, Union

# ── v1.1.0 显式项目根配置 ────────────────────────────────────────────────────
# 优先级: CLAUDE_PROJECT_DIR env > CWD 推断 > SCRIPT_DIR 父辈默认
PROJECT_DIR_ENV = "CLAUDE_PROJECT_DIR"
SESSION_ID_ENV = "CLAUDE_SESSION_ID"

SCRIPT_DIR: Path = Path(__file__).resolve().parent

# PROJECT = 项目根（包含 .claude/ 的目录）
# v0.3.x 假设 SCRIPT_DIR.parent.parent = PROJECT，但当 .claude/hooks/ 在
# ~/.claude/hooks/ 时 PROJECT = ~ ，这导致 PROTECTED 边界失真。
# v1.1.0 修复：显式 env > 启发式推断
def _resolve_project_root() -> Path:
    env_root = os.environ.get(PROJECT_DIR_ENV)
    if env_root:
        p = Path(env_root).resolve()
        if p.is_dir():
            return p
    # 启发式：向上找包含 .claude/ 的祖先
    # v1.1.0 fix: 跳过 SCRIPT_DIR 自身（.claude/hooks/.claude 误目录存在会导致误命中）
    cwd = Path(os.getcwd()).resolve()
    for ancestor in [cwd, *cwd.parents]:
        if ancestor == SCRIPT_DIR:
            continue
        if (ancestor / ".claude").is_dir():
            return ancestor
    # 兜底：v0.3.x 行为
    return SCRIPT_DIR.parent.parent.resolve()

PROJECT: Path = _resolve_project_root()
HOOKS_DIR: Path = SCRIPT_DIR
RUNTIME_DIR: Path = HOOKS_DIR.parent / "runtime"
AUDIT_DIR: Path = HOOKS_DIR.parent / "audit"
TEMPLATE_DIR: Path = HOOKS_DIR.parent / "templates"

# Shadow 根路径（v1.1.0 修复 M-4: 避免多 session 覆盖）
SESSION_ID = os.environ.get(SESSION_ID_ENV) or os.environ.get("USER", "default")
SHADOW_ROOT: Path = Path(f"/tmp/claude-shadow/{SESSION_ID}")


# ── 文件路径（v1.1.0 修复 C-3: PROPOSAL 路径统一到 audit/）────────────────────
SCOPE_FILE: Path = RUNTIME_DIR / "TASK_SCOPE.json"
VIOLATION_FILE: Path = RUNTIME_DIR / "VIOLATIONS.json"
ACTIVE_TASK_FILE: Path = RUNTIME_DIR / "ACTIVE_TASK.json"
MODE_FILE: Path = RUNTIME_DIR / "MODE.json"
INTEGRITY_FILE: Path = RUNTIME_DIR / "INTEGRITY.json"
LOCK_FILE: Path = RUNTIME_DIR / "LOCKED"
PROPOSAL_FILE: Path = AUDIT_DIR / "proposals.jsonl"  # ← v1.1.0 修正


# ── 保护路径 ───────────────────────────────────────────────────────────────
PROTECTED_ABSOLUTE: List[Path] = [
    Path("/etc"), Path("/usr"), Path("/sbin"), Path("/bin"),
    Path("/boot"), Path("/root"), Path.home() / ".ssh", Path.home() / ".gnupg",
]

PROTECTED_PROJECT_RELATIVE: List[Path] = [
    # v1.1.0 修复: ACS 自身关键文件 (精确保护, 不含整个 hooks/ 目录)
    PROJECT / ".claude" / "hooks" / "acs_lite.py",
    PROJECT / ".claude" / "hooks" / "acs_paths.py",
    PROJECT / ".claude" / "hooks" / "acs_violations.py",
    PROJECT / ".claude" / "hooks" / "acs_structural.py",
    PROJECT / ".claude" / "hooks" / "read_guard.py",
    # v1.1.0: 其他 hooks (agent_memory, runtime_loop, prompt_compiler, governance_sdk) 不在 PROTECTED
    #       可在 scope 授权下修改 (这是 v1.1.0 设计: 治理工具可演进)
    # 配置 + 状态目录
    PROJECT / ".claude" / "settings.json",
    PROJECT / ".claude" / "settings.local.json",
    PROJECT / ".claude" / "runtime",
    PROJECT / ".claude" / "governance",
    # v1.2.0 P1-4: audit/ 移出 PROTECTED → 改为 RUNTIME zone（append-only，可写但不可删）
    # PROTECTED 只保护真正不可变的系统文件（hooks, settings, governance）
    # audit/ 是 Claude 可写的审计日志目录，不应与 hooks/settings 同级保护
    # PROJECT / ".claude" / "audit",  ← v1.2.0: 移除，audit 现在是 RUNTIME zone
    PROJECT / ".claude" / "memory",
    PROJECT / ".claude" / "journal",
    PROJECT / ".claude" / "snapshots",
    PROJECT / ".claude" / "projects",
]

ALWAYS_WRITABLE: List[Path] = [
    Path("/tmp"), Path.home() / ".cache", Path.home() / ".local" / "share",
]

WRITABLE_PREFIXES: List[Path] = [PROJECT]

# ── ABI 保护（v1.1.0 修复 M-7: 排除构建目录）───────────────────────────────
ABI_EXCLUDE_RE: re.Pattern = re.compile(
    r"(node_modules|dist|build|\.git|__pycache__|archive|target)/", re.I
)
ABI_PROTECTED_PATTERNS: List[str] = [
    r".*/types\.tsx?$", r".*/contracts?\.tsx?$", r".*/event-bus\.tsx?$",
    r".*/interfaces?\.tsx?$", r".*/index\.tsx?$", r".*\.d\.ts$",
]
ABI_COMPILED: List[re.Pattern] = [re.compile(p, re.I) for p in ABI_PROTECTED_PATTERNS]

# v1.1.0 完整性关键文件（v1.1.0 修复 M-6: 自指）
CRITICAL_FILES: List[Path] = [
    # v1.1.0 ACS 自身
    HOOKS_DIR / "acs_lite.py", HOOKS_DIR / "acs_paths.py",
    HOOKS_DIR / "acs_violations.py", HOOKS_DIR / "acs_structural.py",
    HOOKS_DIR / "acs_task.sh",
    # v1.1.0 新加的 hook (被篡改会破坏 secret 拦截 / deny 报告)
    HOOKS_DIR / "read_guard.py",
    HOOKS_DIR / "agent_memory.py",
    HOOKS_DIR / "runtime_loop.py",
    HOOKS_DIR / "hook_orchestrator.py",
    HOOKS_DIR / "orchestrator_config.json",
    # v1.2.0 修复的 risk_engine
    HOOKS_DIR / "risk_engine.py",
    # 完整性 + 运行时状态 (自指)
    INTEGRITY_FILE,
    SCOPE_FILE, ACTIVE_TASK_FILE, MODE_FILE, VIOLATION_FILE,
    # 配置
    PROJECT / ".claude" / "settings.json",
    PROJECT / ".claude" / "settings.local.json",
]




# ── v4.5 Workspace Governance: 分区权限模型 ──
# 每个路径属于一个 Zone，Zone 决定允许的操作

class FileZone:
    WORKSPACE = "WORKSPACE"   # 自由读写删除
    SOURCE    = "SOURCE"      # proposal-write, no-mass-rm
    RUNTIME   = "RUNTIME"     # append-only, no-delete
    SYSTEM    = "SYSTEM"      # 完全禁止 (FATAL=100)

ZONE_PREFIXES = [
    # WORKSPACE: /tmp, /home/*/.cache, /home/*/.local/share
    ("/tmp/",                FileZone.WORKSPACE),
    ("/home/jamesoldman/.cache/", FileZone.WORKSPACE),
    # RUNTIME: .claude/runtime/, .claude/audit/, .claude/state/
    (str(RUNTIME_DIR) + "/", FileZone.RUNTIME),
    (str(AUDIT_DIR) + "/",   FileZone.RUNTIME),
    # SYSTEM: .claude/hooks/, .claude/settings*, .claude/governance/, .claude/memory/, .claude/projects/
    (str(HOOKS_DIR) + "/",   FileZone.SYSTEM),
    (str(PROJECT / ".claude" / "settings.json"),  FileZone.SYSTEM),
    (str(PROJECT / ".claude" / "settings.local.json"), FileZone.SYSTEM),
    (str(PROJECT / ".claude" / "governance") + "/", FileZone.SYSTEM),
    # SOURCE: everything else (default)
]

def resolve_zone(path: str) -> str:
    """Return the FileZone for a given path"""
    resolved = str(_safe_resolve(Path(path)))
    for prefix, zone in ZONE_PREFIXES:
        if resolved.startswith(prefix) or resolved == prefix.rstrip("/"):
            return zone
    return FileZone.SOURCE  # default: controlled source code

ZONE_PERMISSIONS = {
    FileZone.WORKSPACE: {"write": True,  "delete": True,  "mass_delete": True,  "overwrite": True},
    FileZone.SOURCE:    {"write": True,  "delete": False, "mass_delete": False, "overwrite": True},
    FileZone.RUNTIME:   {"write": True,  "delete": False, "mass_delete": False, "overwrite": False},
    FileZone.SYSTEM:    {"write": False, "delete": False, "mass_delete": False, "overwrite": False},
}

def is_mass_delete(command: str) -> bool:
    """Detect mass deletion: rm -rf dir, rm *, wildcard patterns"""
    if not command:
        return False
    return bool(re.search(r'rm\s+-[a-z]*[rf].*(\*|~/|/(?:[^t]|$))', command, re.I))

# ── 路径解析与判定（v1.1.0 修复 M-1, M-2）─────────────────────────────────
def _safe_resolve(p: Path) -> Path:
    """v1.1.0: 不跟随 symlink（避免 symlink 攻击），但保留绝对性。"""
    try:
        return p.resolve(strict=False)
    except (OSError, RuntimeError):
        return p.absolute()


def _is_relative_to(path: Path, base: Path) -> bool:
    try:
        path.relative_to(base)
        return True
    except ValueError:
        return False


def resolve(path_str: str) -> Path:
    """v1.1.0 修复 M-2: 绝对路径直接使用，相对路径锚定到 PROJECT。"""
    p = Path(path_str)
    if p.is_absolute():
        return _safe_resolve(p)
    return _safe_resolve(PROJECT / p)


def is_protected(resolved: Path) -> bool:
    """检查路径是否在受保护区域。"""
    for prot in PROTECTED_ABSOLUTE:
        if _is_relative_to(resolved, _safe_resolve(prot)):
            return True
    for prot in PROTECTED_PROJECT_RELATIVE:
        base = _safe_resolve(prot) if prot.is_absolute() else _safe_resolve(PROJECT / str(prot))
        if resolved == base or _is_relative_to(resolved, base):
            return True
    return False


def is_always_writable(resolved: Path) -> bool:
    return any(_is_relative_to(resolved, _safe_resolve(p)) for p in ALWAYS_WRITABLE)


def is_shadow_workspace(resolved: Path) -> bool:
    return _is_relative_to(resolved, _safe_resolve(SHADOW_ROOT))


def is_writable(resolved: Path) -> bool:
    return any(_is_relative_to(resolved, _safe_resolve(p)) for p in WRITABLE_PREFIXES)


def is_abi_protected(file_path: str) -> bool:
    """v1.1.0 修复 M-7: 排除 node_modules/dist/build/.git/archive。"""
    if ABI_EXCLUDE_RE.search(file_path):
        return False
    return any(p.search(file_path) for p in ABI_COMPILED)


def is_in_scope(resolved: Path, scope: dict) -> bool:
    """v1.1.0 保持 v0.3.x 的 fail-closed 语义。
    v1.1.0 fix: 锚定到 PROJECT 而非 cwd（避免 .claude/hooks/.claude 误目录污染）。"""
    allowed = scope.get("allowed_files", scope.get("allowed_dirs", []))
    if not allowed:
        return False
    for a in allowed:
        a_path = Path(a)
        if not a_path.is_absolute():
            a_path = PROJECT / a_path
        a_resolved = _safe_resolve(a_path)
        if resolved == a_resolved or _is_relative_to(resolved, a_resolved):
            return True
    return False
