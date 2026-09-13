#!/usr/bin/env python3
"""
filesystem_guard.py — PreToolUse Hook
阻止 Claude 直接写入受保护路径。

设计原则：
- 默认允许写入（白名单思维）
- 只拦截明确保护的路径
- 保护范围不限于某个项目，而是系统级：
  - 所有 .git/ 目录
  - /etc/、/usr/、/sbin/ 等系统目录
  - ~/.ssh/、~/.gnupg/ 等敏感配置
  - 任何项目的 src/ 目录（通过配置）
  - 宪法和 Runtime 配置
- TASK_SCOPE 动态白名单：allowed_dirs 内的路径自动放行

exit 0 = allow, exit 2 = block
"""

# Cursor Agent auto-imports Claude hooks from ~/.claude/settings*.json.
# ACS/ORCH is Claude-only — never gate Cursor sessions.
_e = __import__("os").environ
# Cursor Agent injects CURSOR_PROJECT_DIR / CURSOR_VERSION into hook env (not CURSOR_AGENT).
if _e.get("CURSOR_PROJECT_DIR") or _e.get("CURSOR_VERSION") or _e.get("CURSOR_AGENT"):
    raise SystemExit(0)

import fnmatch
import json
import os
import re
import shlex
import sys
from pathlib import Path

# ============================================================
# 配置 + TASK_SCOPE 动态白名单
# ============================================================
CWD = Path(os.environ.get("CLAUDE_CWD", os.getcwd())).resolve()
HOME = Path.home().resolve()
RUNTIME_DIR = HOME / ".claude" / "runtime"
SCOPE_FILE = RUNTIME_DIR / "TASK_SCOPE.json"

_scope_cache = None

def _load_scope():
    global _scope_cache
    try:
        mtime = SCOPE_FILE.stat().st_mtime
        if _scope_cache and _scope_cache[0] == mtime:
            return _scope_cache[1]
        data = json.loads(SCOPE_FILE.read_text())
        dirs = [Path(d).resolve() for d in data.get("allowed_dirs", [])]
        files = [Path(f).resolve() for f in data.get("allowed_files", [])]
        _scope_cache = (mtime, dirs + files)
        return _scope_cache[1]
    except Exception:
        return []

def _is_in_scope(path: Path):
    for d in _load_scope():
        try:
            path.relative_to(d)
            return True
        except ValueError:
            continue
    return False

# 受保护路径（fnmatch glob 风格）
# 格式: (pattern, reason)
# pattern 可以是：
#   - 相对路径（相对于 CWD）
#   - 绝对路径前缀
PROTECTED = [
    # ===== 系统级保护（最高优先级）=====
    # Git 元数据 — 防止 Agent 篡改 git 历史
    (".git/**", "Git 元数据"),
    # SSH 密钥和配置
    (".ssh/**", "SSH 配置"),
    (HOME / ".ssh" / "**", "SSH 配置(绝对路径)"),
    # GPG 密钥
    (".gnupg/**", "GPG 密钥"),
    (HOME / ".gnupg" / "**", "GPG 密钥(绝对路径)"),
    # 系统目录（绝对路径）
    ("/etc/**", "系统配置"),
    ("/usr/**", "系统程序"),
    ("/sbin/**", "系统程序"),
    ("/bin/**", "系统程序"),
    ("/boot/**", "系统引导"),
    ("/root/**", "root 用户目录"),

    # ===== Claude Runtime 保护 =====
    (".claude/CLAUDE.md", "宪法文件"),
    ("CLAUDE.md", "宪法文件(绝对路径)"),
    (".claude/settings.json", "Runtime 配置"),

    # ===== 项目源码保护（TASK_SCOPE 可覆盖）=====
    # gaokao 项目
    ("my-project/projects/gaokao/frontend/src/**", "gaokao 前端源码"),
    ("my-project/projects/gaokao/backend/**", "gaokao 后端源码"),
    ("my-project/projects/gaokao/data/**", "gaokao 生产数据"),
    ("my-project/projects/gaokao/config/**", "gaokao 项目配置"),
    # 其他项目（按需添加）
    # ("my-project/other-project/src/**", "other-project 源码"),
]

# 允许直接写入的目录前缀（白名单）
WRITABLE_PREFIXES = [
    ".claude/runtime/",
    ".claude/audit/",
    ".claude/snapshots/",
    ".claude/governance/",
    ".claude/hooks/",
    "/tmp/claude-shadow/",
    "/tmp/",
    # 下载和缓存目录
    HOME / ".cache" / "",
    HOME / ".local" / "share" / "",
]

# 危险 glob 模式：批量修改命令
DANGEROUS_GLOB_PATTERNS = [
    r'find\s+.*-exec\s+sed\s+-[a-z]*i',
    r'find\s+.*-exec\s+(cp|mv|rm)\b',
    r'find\s+.*\|\s*xargs\s+(sed|cp|mv|rm)\b',
    r'(chmod|chown)\s+-[a-z]*R\s+(/[^a-z]|\.|~/|\.\./)',
]

COMPILED_GLOBS = [re.compile(p, re.IGNORECASE) for p in DANGEROUS_GLOB_PATTERNS]

# 写入意图命令词（\b 防止 "permission"/"format" 等子串误命中 "rm"）
_WRITE_CMD_RE = re.compile(r'\b(?:tee|cp|mv|rm|rmdir|mkdir|touch|chmod|chown)\b')

# ============================================================
# 工具函数
# ============================================================

def _resolve(path_str: str) -> Path:
    """解析路径，展开 symlink"""
    p = Path(path_str)
    if not p.is_absolute():
        p = CWD / p
    try:
        return p.resolve(strict=False)
    except (OSError, RuntimeError):
        return p.absolute()


def _match_protected(path: Path) -> tuple:
    """检查路径是否受保护。返回 (bool, reason)"""
    abs_str = str(path)
    # 尝试相对路径
    try:
        rel = str(path.relative_to(CWD))
        candidates = [rel, path.name]
    except ValueError:
        candidates = [abs_str, path.name]

    for cand in candidates:
        for pattern, reason in PROTECTED:
            pat_str = str(pattern)
            if fnmatch.fnmatch(cand, pat_str):
                return True, reason
            # 也检查绝对路径前缀匹配
            if abs_str.startswith(pat_str.rstrip('*')):
                return True, reason
    return False, ""


def _is_writable(path: Path) -> bool:
    s = str(path)
    return any(s.startswith(str(prefix)) for prefix in WRITABLE_PREFIXES)


def _check_dangerous_glob(cmd: str) -> tuple:
    for pattern in COMPILED_GLOBS:
        if pattern.search(cmd):
            return True, f"危险批量修改: {cmd[:100]}"
    return False, ""


# ============================================================
# 检查器
# ============================================================

def _check_write(data: dict) -> tuple:
    if data.get("tool_name") not in ("Write", "Edit"):
        return False, ""
    fp = data.get("tool_input", {}).get("file_path", "")
    if not fp:
        return False, ""

    resolved = _resolve(fp)

    # symlink 检查
    raw = Path(fp) if Path(fp).is_absolute() else CWD / fp
    if raw.is_symlink():
        real = raw.resolve()
        prot, reason = _match_protected(real)
        if prot:
            return True, f"symlink 绕过: {fp} → {real} ({reason})"

    if _is_writable(resolved):
        return False, ""
    if _is_in_scope(resolved):
        return False, ""
    prot, reason = _match_protected(resolved)
    if prot:
        return True, f"受保护: {fp} — {reason}"
    return False, ""


def _check_bash(data: dict) -> tuple:
    """v0.3.x 语义分类: READ总是放行 / WRITE检查路径 / DESTROY拦截"""
    if data.get("tool_name") != "Bash":
        return False, ""
    cmd = data.get("tool_input", {}).get("command", "")
    if not cmd:
        return False, ""

    # 0. DANGEROUS_GLOB (最高优先级 - find -exec rm, xargs sed 等批量操作)
    blocked, reason = _check_dangerous_glob(cmd)
    if blocked:
        return True, reason

    # 0.5 FAIL-CLOSED: 任何递归删除 (`rm -r` / `rm -rf` / `rm -fr` / `rm -Rf`，
    # 不论目标目录) 一律拦截，无需审核。与 claude/codebuddy 引擎及 adapters 的
    # "危险命令直接拒绝并扣分" 策略保持一致。
    if re.search(r"\brm\b\s+-[a-zA-Z]*[rR][a-zA-Z]*\b", cmd):
        return True, f"危险命令 rm 递归删除已拦截（任何目录）: {cmd[:100]}"

    # 1. READ-ONLY: 纯只读命令白名单 → 无条件放行
    READ_ONLY = frozenset({
        "ls", "cat", "head", "tail", "less", "more", "stat", "file", "wc",
        "find", "grep", "egrep", "fgrep", "rg", "ag", "ack",
        "awk", "sed", "gawk",
        "sort", "uniq", "cut", "tr", "comm", "diff", "cmp",
        "md5sum", "sha256sum", "sha1sum", "cksum",
        "tree", "du", "df", "ps", "lsof", "readlink", "realpath",
        "basename", "dirname", "pwd", "printenv", "date", "whoami", "id",
        "which", "type", "command", "uname", "arch", "hostname",
        "echo", "printf", "true", "false",
        "git",
        "node", "python", "python3", "tsc", "tsx", "npx",
        "pnpm", "npm", "yarn", "bun",
        "cargo", "go", "java", "javac", "rustc",
        "curl", "wget",
        "gh", "jq", "sqlite3",
    })

    try:
        tokens = shlex.split(cmd)
    except ValueError:
        return False, ""

    if not tokens:
        return False, ""

    first = tokens[0].split("/")[-1]

    # >/dev/null (含 2>/dev/null、&>/dev/null) 是纯输出抑制，不是写入信号，需与 fd 复制(2>&1)一并剔除
    _stripped_for_redirect_check = re.sub(r'\d*>&\d*-?|&?\d*>\s*/dev/null', '', cmd)
    _real_redirect = '>' in _stripped_for_redirect_check
    has_write_flag = _real_redirect or bool(_WRITE_CMD_RE.search(cmd))
    has_destructive = any(w in cmd for w in ("dd", "mkfs", "kill -9", "reboot", "shutdown"))

    is_sed_inplace = first == "sed" and any("-i" in t or "--in-place" in t for t in tokens[1:])

    if first in READ_ONLY and not has_write_flag and not is_sed_inplace:
        return False, ""

    if has_destructive:
        return False, ""

    # 3. WRITE: 有写入意图的命令 → 检查被写入路径
    skip = {"echo", "cat", "tee", "cp", "mv", "sed", "printf",
            "find", "xargs", ">", ">>", "rm", "mkdir", "touch",
            "sudo", "su", "&&", "||", "|", "if", "then", "else",
            "fi", "do", "done", "for", "in", "[", "test",
            "node", "python", "python3", "bash", "sh"}
    for tok in tokens:
        tok = tok.strip("'\"")
        if not tok or tok.startswith("-") or tok in skip:
            continue
        if "/" not in tok and not tok.startswith("."):
            continue
        resolved = _resolve(tok)
        if _is_writable(resolved):
            continue
        if _is_in_scope(resolved):
            continue
        prot, reason = _match_protected(resolved)
        if prot:
            return True, f"写入受保护: {tok} — {reason}"
    return False, ""


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    for checker in (_check_write, _check_bash):
        blocked, reason = checker(data)
        if blocked:
            print(f"[FILESYSTEM GUARD] {reason}", file=sys.stderr)
            print("[FILESYSTEM GUARD] 必须通过 Proposal → Shadow → Verify → Approve", file=sys.stderr)
            sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
