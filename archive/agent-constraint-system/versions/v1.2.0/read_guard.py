#!/usr/bin/env python3
"""
read_guard.py v1.2.0 — PreToolUse Hook: 拦截 secret 文件访问

v1.1.0 修复 (C-2): SENSITIVE_FILE_PATTERNS / SYSTEM_SENSITIVE / CC_SETTINGS_DENY
v1.2.0 P2-7 修复: settings.json 在研发模式下允许读取（改为警告而非硬拦截）
v1.2.0+: 移除 BLOCKED_EXTENSIONS（.ts/.py/.js 等源文件拦截），不再做 token 优化
"""

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
]

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

    for prefix in ALLOWED_PREFIXES:
        if prefix in fp:
            sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()