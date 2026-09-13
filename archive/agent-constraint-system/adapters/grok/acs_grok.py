#!/usr/bin/env python3
"""
acs_grok.py -- Grok Build (xAI) Adapter

Grok Build is a Claude Code fork — it reads hook/permission definitions
from ~/.claude/settings.local.json and executes Claude's hook chain
(hook_orchestrator.py). This adapter is a reference implementation for
future independent deployment; currently Grok runs Claude's ACS directly.

Hook events: PreToolUse (Bash/Write), PostToolUse (audit)
CLI: acs_grok.py init | status | unlock --confirm | reset --force --confirm
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

CORE_DIR = os.path.join(Path.home(), ".acs_core")
sys.path.insert(0, CORE_DIR)

from guard import check_bash_with_context
from paths import is_forbidden_path
from violations import add_violation, clear_violations, window_score, should_lock, load_violations, integrity_store, integrity_verify
from audit import AuditLogger
from asset_ledger import AssetLedger, AssetTracker
from safe_mode import SafeMode

# Grok-specific paths
GROK_DIR = Path.home() / ".grok"
RUNTIME_DIR = GROK_DIR / "grok_acs_runtime"
VIOLATIONS_FILE = RUNTIME_DIR / "violations.json"
LOCK_FILE = RUNTIME_DIR / "LOCK.json"
INTEGRITY_FILE = RUNTIME_DIR / "integrity.json"
AUDIT_LOG = RUNTIME_DIR / "tool-audit.jsonl"
CRITICAL_FILES = [Path(__file__).resolve()]

audit = AuditLogger(AUDIT_LOG)
ledger = AssetLedger(str(RUNTIME_DIR / "asset_ledger.json"))
tracker = AssetTracker(ledger)
safe_mode = SafeMode(str(RUNTIME_DIR / "safe_mode.json"))


def _deny(reason: str) -> None:
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"[GACS] {reason}",
        }
    }, sys.stdout)
    sys.exit(0)


def handle_bash(data: dict) -> None:
    command = data.get("tool_input", {}).get("command", "")
    if not command:
        return
    cmd = command.strip()
    if "acs_grok.py unlock" in cmd or ("acs_grok.py reset" in cmd and "--force" in cmd):
        return

    result = check_bash_with_context(command, asset_ledger=ledger, error_count=safe_mode.error_count())
    if result["decision"] == "BLOCK":
        audit.log("PreToolUse", "Bash", data.get("session_id", ""), "deny", result["reason"])
        ws, locked, _ = add_violation(VIOLATIONS_FILE, LOCK_FILE, f"dangerous_command:{cmd[:200]}", 100)
        _deny(result["reason"])
    elif result["decision"] == "CONFIRM":
        audit.log("PreToolUse", "Bash", data.get("session_id", ""), "confirm", result["reason"])
        _deny(f"[CONFIRM REQUIRED] {result['reason']}")

    # Auto-track: detect mv and record the move
    import re
    mv_match = re.search(r"\bmv\s+(\S+)\s+(\S+)", cmd)
    if mv_match:
        tracker.on_move(mv_match.group(1), mv_match.group(2))

    if should_lock(load_violations(VIOLATIONS_FILE)):
        ws = window_score(load_violations(VIOLATIONS_FILE))
        _deny(f"System locked (violation window={ws})")


def handle_write(data: dict) -> None:
    fp = data.get("tool_input", {}).get("file_path", "")
    if not fp:
        return
    root = is_forbidden_path(fp)
    if root:
        ws, locked, _ = add_violation(VIOLATIONS_FILE, LOCK_FILE, f"forbidden: {fp}", 100)
        audit.log("PreToolUse", data.get("tool_name", ""), data.get("session_id", ""), "deny", f"forbidden_root: {root}")
        _deny(f"Write to {fp} (under {root}) is forbidden")


def cli() -> None:
    cmd = sys.argv[1]
    if cmd == "init":
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        integrity_store(INTEGRITY_FILE, CRITICAL_FILES)
        ok, msg = integrity_verify(INTEGRITY_FILE)
        print(f"[GACS] Initialized: {RUNTIME_DIR}")
        print(f"[GACS] Integrity: {msg}")
        print(f"[GACS] Asset Ledger + Safe Mode active")
        sys.exit(0)
    elif cmd == "unlock":
        if "--confirm" not in sys.argv:
            print("[GACS] unlock requires --confirm", file=sys.stderr)
            sys.exit(1)
        clear_violations(VIOLATIONS_FILE, LOCK_FILE)
        safe_mode.reset()
        audit.clear()
        print("[GACS] Unlocked")
        sys.exit(0)
    elif cmd == "reset":
        if "--confirm" not in sys.argv:
            print("[GACS] reset requires --confirm", file=sys.stderr)
            sys.exit(1)
        if "--force" in sys.argv:
            for f in RUNTIME_DIR.glob("*"):
                f.unlink()
            ledger.clear()
            safe_mode.reset()
            print("[GACS] Full reset")
        sys.exit(0)
    elif cmd == "status":
        print("[GACS] Status Report")
        if not RUNTIME_DIR.exists():
            print("  NOT INITIALIZED")
            sys.exit(0)
        v = load_violations(VIOLATIONS_FILE)
        ws = window_score(v)
        locked = should_lock(v)
        ok, msg = integrity_verify(INTEGRITY_FILE)
        print(f"  Violations: ws={ws}, locked={locked}")
        print(f"  Audit: {audit.total_count()} entries")
        print(f"  Integrity: {msg}")
        print(f"  Safe Mode: active={safe_mode.is_active()}")
        print(f"  Assets: {len(ledger._assets)} tracked")
        sys.exit(0)


def main() -> None:
    if len(sys.argv) > 1:
        cli()
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    event = data.get("hook_event_name", "")
    tool = data.get("tool_name", "")
    if event == "PreToolUse":
        if tool == "Bash":
            handle_bash(data)
        elif tool in ("Write", "Edit", "MultiEdit"):
            handle_write(data)
    elif event == "PostToolUse":
        audit.log(event, tool, data.get("session_id", ""), "allow")
    elif event == "Stop":
        audit.log(event, tool, data.get("session_id", ""), "stop")


if __name__ == "__main__":
    main()
