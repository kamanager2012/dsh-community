#!/usr/bin/env python3
"""
read_guard.py v1.2.0 — PreToolUse Hook: 拦截不必要的 Read + secret 文件访问

v1.1.0 修复 (C-2): SENSITIVE_FILE_PATTERNS / SYSTEM_SENSITIVE / CC_SETTINGS_DENY
v1.2.0 P2-7 修复: settings.json 在研发模式下允许读取（改为警告而非硬拦截）
  - 研发模式（MODE=ACTIVE/RESEARCH）→ 允许 read + 警告
  - 非研发模式 → 拒绝、建议使用 grep 特定 key 替代
"""

# Cursor Agent auto-imports Claude hooks from ~/.claude/settings*.json.
# ACS/ORCH is Claude-only — never gate Cursor sessions.
_e = __import__("os").environ
# Cursor Agent injects CURSOR_PROJECT_DIR / CURSOR_VERSION into hook env (not CURSOR_AGENT).
if _e.get("CURSOR_PROJECT_DIR") or _e.get("CURSOR_VERSION") or _e.get("CURSOR_AGENT"):
    raise SystemExit(0)

import json
import os
import re
import sys
from pathlib import Path

RUNTIME_DIR = Path(__file__).resolve().parent.parent / "runtime"
MODE_FILE = RUNTIME_DIR / "MODE.json"

# ── 允许 Read 的前缀 ───────────────────────────────────
ALLOWED_PREFIXES = [
    ".claude/state",
    ".claude/governance",
    ".claude/modules",
    ".claude/hooks",
    "/tmp/",
    "package.json",
    "tsconfig.json",
    "vitest.config.ts",
    # v1.2.0: 高考项目 Review mode 白名单
    "/home/jamesoldman/my-project/projects/gaokao/",
    # v4.3: mystic-platform（玄学项目，Claude 负责）白名单
    "/home/jamesoldman/mystic-platform/",
    # v4.4: agent-constraint-system（ACS 工具自身仓库，含 archive/）白名单
    "/home/jamesoldman/agent-constraint-system/",
]

BLOCKED_EXTENSIONS = {".ts", ".tsx", ".py", ".js", ".jsx"}

# ── v1.1.0 敏感文件绝对 deny (C-2) ────────────────────────────
SENSITIVE_FILE_PATTERNS = [
    re.compile(r".*\.env$", re.I),
    re.compile(r".*\.env\..+$", re.I),
    re.compile(r".*\.netrc$", re.I),
    re.compile(r".*/\.aws/credentials$", re.I),
    re.compile(r".*/\.aws/config$", re.I),
    re.compile(r".*/\.ssh/(id_rsa|id_ed25519|id_ecdsa|known_hosts|config|authorized_keys)$", re.I),
    re.compile(r".*/\.gnupg/.*$", re.I),
    re.compile(r".*/\.npmrc$", re.I),
    re.compile(r".*/\.pypirc$", re.I),
    re.compile(r".*/\.docker/config\.json$", re.I),
    re.compile(r".*/\.kube/config$", re.I),
]

SYSTEM_SENSITIVE_PATTERNS = [
    re.compile(r".*/etc/shadow$", re.I),
    re.compile(r".*/etc/passwd$", re.I),
    re.compile(r".*/etc/sudoers$", re.I),
    re.compile(r".*/etc/sudoers\.d/.*$", re.I),
]

CC_SETTINGS_DENY = [
    re.compile(r".*/\.claude/settings\.json$", re.I),
    re.compile(r".*/\.claude/settings\.local\.json$", re.I),
]

CC_SETTINGS_ALLOWED = [
    re.compile(r".*/\.claude/settings\.example\.json$", re.I),
]

# v1.2.0 P2-7: 研发模式允许读取的 MODE 值
RESEARCH_MODES = {"ACTIVE", "RESEARCH"}


def _current_mode() -> str:
    """读取当前 MODE.json 获取运行模式。"""
    try:
        if MODE_FILE.exists():
            data = json.loads(MODE_FILE.read_text())
            return data.get("mode", "UNKNOWN")
    except (OSError, json.JSONDecodeError):
        pass
    return "UNKNOWN"


def _is_sensitive(fp: str):
    for p in SENSITIVE_FILE_PATTERNS:
        if p.match(fp):
            return ("sensitive", "user secret file")
    for p in SYSTEM_SENSITIVE_PATTERNS:
        if p.match(fp):
            return ("system", "system credential")
    for p in CC_SETTINGS_ALLOWED:
        if p.match(fp):
            return None
    for p in CC_SETTINGS_DENY:
        if p.match(fp):
            return ("cc_secret", "Claude Code settings 含 ANTHROPIC_AUTH_TOKEN，请用 env var 或 grep 特定 key")
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if data.get("tool_name") != "Read":
        sys.exit(0)

    fp = data.get("tool_input", {}).get("file_path", "")
    if not fp:
        sys.exit(0)

    sensitive = _is_sensitive(fp)
    if sensitive:
        kind, reason = sensitive

        # v1.2.0 P2-7: settings.json 在研发模式下允许读取（只警告）
        if kind == "cc_secret":
            mode = _current_mode()
            if mode in RESEARCH_MODES:
                # 研发模式：允许读取，但输出警告
                print(f"[READ GUARD] WARNING (cc_secret, mode={mode}): {fp}", file=sys.stderr)
                print(f"[READ GUARD] {reason}", file=sys.stderr)
                print(f"[READ GUARD] 研发模式下允许读取，但请勿泄露敏感值", file=sys.stderr)
                sys.exit(0)  # 允许
            else:
                # 非研发模式：硬拦截
                print(f"[READ GUARD] BLOCKED (cc_secret): {fp}", file=sys.stderr)
                print(f"[READ GUARD] {reason}", file=sys.stderr)
                print(f"[READ GUARD] 推荐: 把 secret 移到 ~/.claude/.env (chmod 600)，settings.json 只引用 env var 名", file=sys.stderr)
                sys.exit(2)  # 拒绝

        # 其他敏感文件始终硬拦截
        print(f"[READ GUARD] BLOCKED ({kind}): {fp}", file=sys.stderr)
        print(f"[READ GUARD] {reason}", file=sys.stderr)
        sys.exit(2)

    fp_resolved = Path(fp).resolve()
    for prefix in ALLOWED_PREFIXES:
        if "/" in prefix:
            # Path-aware matching: prevent substring bypass
            resolved_prefix = Path(prefix)
            if not resolved_prefix.is_absolute():
                resolved_prefix = Path.home() / prefix
            try:
                if fp_resolved.is_relative_to(resolved_prefix.resolve()):
                    sys.exit(0)
            except (ValueError, OSError):
                pass
        else:
            # Bare filename match (e.g., "package.json"): exact basename only
            if Path(fp).name == prefix:
                sys.exit(0)

    for ext in BLOCKED_EXTENSIONS:
        if fp.endswith(ext):
            print(f"[READ GUARD] BLOCKED: {fp}", file=sys.stderr)
            print(f"[READ GUARD] 非研发模式禁止 Read 源文件。用 prompt_compiler.py 或 grep 替代。", file=sys.stderr)
            sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()