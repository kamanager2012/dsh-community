#!/usr/bin/env python3
"""
acs_cursor.py -- Cursor Adapter (indirect via shell bootstrap)

Cursor hooks through Claude's hook infrastructure, using Cursor's
own runtime at ~/.cursor/runtime/.
"""
from __future__ import annotations

import json, os, sys
from pathlib import Path

CORE_DIR = os.path.join(Path.home(), ".acs_core")
sys.path.insert(0, CORE_DIR)

from guard import check_bash_with_context
from paths import is_forbidden_path
from violations import add_violation, clear_violations, window_score, should_lock, load_violations, integrity_store, integrity_verify
from audit import AuditLogger
from asset_ledger import AssetLedger
from safe_mode import SafeMode

CURSOR_DIR = Path.home() / ".cursor"
RUNTIME_DIR = CURSOR_DIR / "runtime"
VIOLATIONS_FILE = RUNTIME_DIR / "VIOLATIONS.json"
LOCK_FILE = RUNTIME_DIR / "LOCKED"
INTEGRITY_FILE = RUNTIME_DIR / "INTEGRITY.json"
AUDIT_LOG = RUNTIME_DIR / "tool-audit.jsonl"

audit = AuditLogger(AUDIT_LOG)
ledger = AssetLedger(str(RUNTIME_DIR / "asset_ledger.json"))
safe_mode = SafeMode()


def _deny(reason):
    json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": f"[CrACS] {reason}"}}, sys.stdout)
    sys.exit(0)


def handle_bash(data):
    cmd = data.get("tool_input", {}).get("command", "").strip()
    if not cmd or "acs_cursor.py unlock" in cmd:
        return
    result = check_bash_with_context(cmd, asset_ledger=ledger, error_count=safe_mode.error_count())
    if result["decision"] == "BLOCK":
        ws, locked, _ = add_violation(VIOLATIONS_FILE, LOCK_FILE, f"dangerous_command:{cmd[:200]}", 100)
    if result["decision"] in ("BLOCK", "CONFIRM"):
        _deny(result["reason"])
    if should_lock(load_violations(VIOLATIONS_FILE)):
        _deny(f"Locked (window={window_score(load_violations(VIOLATIONS_FILE))})")


def handle_write(data):
    fp = data.get("tool_input", {}).get("file_path", "")
    if fp and is_forbidden_path(fp):
        add_violation(VIOLATIONS_FILE, LOCK_FILE, f"forbidden:{fp}", 100)
        _deny(f"Forbidden: {fp}")


def cli():
    if sys.argv[1] == "init":
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        integrity_store(INTEGRITY_FILE, [Path(__file__).resolve()])
        print("[CrACS] Initialized")
    elif sys.argv[1] == "unlock":
        clear_violations(VIOLATIONS_FILE, LOCK_FILE); safe_mode.reset()
        print("[CrACS] Unlocked")
    elif sys.argv[1] == "status":
        v = load_violations(VIOLATIONS_FILE)
        print(f"[CrACS] ws={window_score(v)} locked={should_lock(v)} assets={len(ledger._assets)}")
    sys.exit(0)


def main():
    if len(sys.argv) > 1: cli()
    try: data = json.load(sys.stdin)
    except: sys.exit(0)
    event, tool = data.get("hook_event_name", ""), data.get("tool_name", "")
    if event == "PreToolUse":
        if tool == "Bash": handle_bash(data)
        elif tool in ("Write", "Edit"): handle_write(data)


if __name__ == "__main__":
    main()
