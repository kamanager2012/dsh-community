#!/usr/bin/env python3
"""
hook_orchestrator.py — v5.0 统一 hook 调度器

v5.0 变更:
  - DEFAULT_CONFIG 与 orchestrator_config.json 同步（proposal_guard 移至 PostToolUse）
  - 版本号更新为 v5.0
  - deny report 版本号 v5.0
"""
from __future__ import annotations

# Cursor Agent auto-imports Claude hooks from ~/.claude/settings*.json.
# ACS/ORCH is Claude-only — never gate Cursor sessions.
_e = __import__("os").environ
# Cursor Agent injects CURSOR_PROJECT_DIR / CURSOR_VERSION into hook env (not CURSOR_AGENT).
if _e.get("CURSOR_PROJECT_DIR") or _e.get("CURSOR_VERSION") or _e.get("CURSOR_AGENT"):
    raise SystemExit(0)

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

HOOKS_DIR: Path = Path("/home/jamesoldman/.claude/hooks")
CONFIG_FILE: Path = HOOKS_DIR / "orchestrator_config.json"
HOOK_TIMEOUT: int = 30  # 单 hook 超时 (秒)

# ── 默认配置 v5.0: 与 orchestrator_config.json 保持同步 ──────────────────
DEFAULT_CONFIG: Dict[str, Any] = {
    "PreToolUse": {
        "Write|Edit": [
            "acs_lite.py",
            "filesystem_guard.py",
        ],
        "Bash": [
            "acs_lite.py",
            "sed_guard.py",
            "filesystem_guard.py",
        ],
        "Read": [
            "read_guard.py",
        ],
    },
    "PostToolUse": {
        "Write|Edit|Bash": [
            "abi_guard.py",
            "audit_hook.py",
            "token_budget.py",
            "risk_engine.py",
        ],
        "Write|Edit": [
            "proposal_guard.py",
        ],
        "Read": [
            "agent_memory.py",
        ],
    },
    "Stop": [
        "acs_lite.py status",
        "stability_report.py check",
        "runtime_loop.py tick --reason session_end",
    ],
}


def load_config() -> Dict[str, Any]:
    """加载配置: 用户 config 覆盖 DEFAULT 同名 key."""
    if not CONFIG_FILE.exists():
        return DEFAULT_CONFIG
    try:
        user_cfg = json.loads(CONFIG_FILE.read_text())
        # 深拷贝 default
        merged: Dict[str, Any] = json.loads(json.dumps(DEFAULT_CONFIG))
        for event, evt_cfg in user_cfg.items():
            if event not in merged:
                merged[event] = evt_cfg
                continue
            if isinstance(evt_cfg, dict) and isinstance(merged[event], dict):
                for matcher, hooks in evt_cfg.items():
                    merged[event][matcher] = hooks
            else:
                merged[event] = evt_cfg
        return merged
    except (json.JSONDecodeError, OSError) as e:
        print(f"[ORCH] config load error: {e}, using defaults", file=sys.stderr)
        return DEFAULT_CONFIG


def run_hook(hook_cmd: str, stdin_data: str) -> Dict[str, Any]:
    """调一个 hook 子进程, 收集结果."""
    parts = hook_cmd.split()
    script = parts[0]
    args = parts[1:] if len(parts) > 1 else []
    script_path = HOOKS_DIR / script

    if not script_path.exists():
        return {
            "hook": hook_cmd, "status": "missing", "exit": 0,
            "stderr": f"[ORCH] {script} not found (skipped)", "stdout": "",
            "elapsed_ms": 0,
        }

    t0 = time.time()
    try:
        r = subprocess.run(
            ["python3", str(script_path)] + args,
            input=stdin_data,
            capture_output=True,
            text=True,
            timeout=HOOK_TIMEOUT,
        )
        elapsed = int((time.time() - t0) * 1000)
        return {
            "hook": hook_cmd,
            "status": "allow" if r.returncode == 0 else "deny",
            "exit": r.returncode,
            "stderr": r.stderr[:2000],
            "stdout": r.stdout[:500],
            "elapsed_ms": elapsed,
        }
    except subprocess.TimeoutExpired:
        elapsed = int((time.time() - t0) * 1000)
        return {
            "hook": hook_cmd, "status": "timeout", "exit": -1,
            "stderr": f"[ORCH] {hook_cmd} TIMEOUT after {HOOK_TIMEOUT}s (treated as allow)",
            "stdout": "", "elapsed_ms": elapsed,
        }
    except Exception as e:
        elapsed = int((time.time() - t0) * 1000)
        return {
            "hook": hook_cmd, "status": "error", "exit": -1,
            "stderr": f"[ORCH] {hook_cmd} ERROR: {e} (treated as allow)",
            "stdout": "", "elapsed_ms": elapsed,
        }


def get_hooks_for_event(config: Dict[str, Any], event: str, tool_name: str) -> List[str]:
    """从 config 找匹配 event + tool_name 的 hook 列表."""
    if event not in config:
        return []
    evt_cfg = config[event]
    # Stop 类型: 没有 matcher, 所有 hook 都跑
    if isinstance(evt_cfg, list):
        if event == "Stop":
            return evt_cfg
        return []
    # PreToolUse / PostToolUse: 按 matcher 分组
    hooks: List[str] = []
    for matcher, hks in evt_cfg.items():
        if matcher == tool_name:
            return list(hks)
        if "|" in matcher and tool_name in matcher.split("|"):
            hooks.extend(hks)
    return hooks


def format_deny_report(event: str, tool_name: str, total_hooks: int,
                       executed: List[Dict[str, Any]], denied: List[Dict[str, Any]]) -> str:
    """v5.0 核心: 统一 deny 报告."""
    lines = [
        f"[ORCH v5.0] DENIED: {event}/{tool_name}",
        f"[ORCH v5.0] {total_hooks} hook(s) configured, {len(executed)} executed, "
        f"{len(denied)} denied",
    ]
    for r in executed:
        hook_name = r["hook"].split()[0].replace(".py", "")
        status_marker = "❌" if r["status"] == "deny" else "✓"
        lines.append(f"[ORCH v5.0]   {status_marker} {hook_name} "
                     f"({r['elapsed_ms']}ms, exit {r['exit']})")
        if r["status"] == "deny":
            stderr_first = r["stderr"].split("\n")[0] if r["stderr"] else "(no stderr)"
            lines.append(f"[ORCH v5.0]     → {stderr_first[:300]}")
    if not denied:
        lines.append("[ORCH v5.0] (no explicit deny — exit code 2 from unknown cause)")
    return "\n".join(lines)


def main() -> None:
    try:
        stdin_data = sys.stdin.read()
        data = json.loads(stdin_data)
    except Exception:
        sys.exit(0)

    # 推断 event
    # Claude Code hook JSON 包含 hookEventName (有时) 或通过 stdin 推断
    hook_event = data.get("hookEventName", "")
    tool_name = data.get("tool_name", "")

    if hook_event == "PostToolUse":
        event = "PostToolUse"
    elif hook_event == "Stop" or (not tool_name and not hook_event):
        event = "Stop"
    else:
        event = "PreToolUse"

    config = load_config()
    hooks = get_hooks_for_event(config, event, tool_name)
    if not hooks:
        sys.exit(0)

    # 顺序执行 hook, 第一个 deny 立即停止 (Claude Code 协议)
    executed: List[Dict[str, Any]] = []
    denied: List[Dict[str, Any]] = []
    for hook_cmd in hooks:
        r = run_hook(hook_cmd, stdin_data)
        # P0-1: PreToolUse 安全 hook 失败(超时/崩溃/缺失文件) → deny
        if r["status"] in ("timeout", "error", "missing") and event == "PreToolUse":
            r["status"] = "deny"
            r["exit"] = 2
            r["stderr"] += "\n[ORCH] PreToolUse safety hook failed → deny"
        executed.append(r)
        if r["status"] == "deny":
            denied.append(r)
            break  # 第一个 deny 终止后续 hook

    if denied:
        report = format_deny_report(event, tool_name, len(hooks), executed, denied)
        print(report, file=sys.stderr)
        sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
