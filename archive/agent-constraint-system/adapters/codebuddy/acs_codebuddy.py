#!/usr/bin/env python3
"""
acs_codebuddy.py -- CodeBuddy Code Adapter

Imports from acs_core. Own runtime at ~/.codebuddy/runtime/.
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
from capability_ledger import CapabilityLedger
from safe_mode import SafeMode

CB_DIR = Path.home() / ".codebuddy"
RUNTIME_DIR = CB_DIR / "runtime"
VIOLATIONS_FILE = RUNTIME_DIR / "VIOLATIONS.json"
LOCK_FILE = RUNTIME_DIR / "LOCKED"
INTEGRITY_FILE = RUNTIME_DIR / "INTEGRITY.json"
AUDIT_LOG = RUNTIME_DIR / "tool-audit.jsonl"

audit = AuditLogger(AUDIT_LOG)
ledger = AssetLedger(str(RUNTIME_DIR / "asset_ledger.json"))
cap_ledger = CapabilityLedger(str(RUNTIME_DIR / "capability_ledger.json"))
safe_mode = SafeMode()


def _deny(reason):
    json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": f"[BACS] {reason}"}}, sys.stdout)
    sys.exit(0)


def handle_bash(data):
    cmd = data.get("tool_input", {}).get("command", "").strip()
    if not cmd: return
    if "acs_codebuddy.py unlock" in cmd: return
    result = check_bash_with_context(cmd, asset_ledger=ledger, error_count=safe_mode.error_count(), capability_ledger=cap_ledger)
    if result["decision"] == "BLOCK":
        audit.log("PreToolUse", "Bash", data.get("session_id", ""), "deny", result["reason"])
        ws, locked, _ = add_violation(VIOLATIONS_FILE, LOCK_FILE, f"dangerous_command:{cmd[:200]}", 100)
        _deny(result["reason"])
    elif result["decision"] == "CONFIRM":
        _deny(f"[CONFIRM] {result['reason']}")
    if should_lock(load_violations(VIOLATIONS_FILE)):
        _deny(f"Locked (window={window_score(load_violations(VIOLATIONS_FILE))})")


def handle_write(data):
    fp = data.get("tool_input", {}).get("file_path", "")
    if not fp: return
    if is_forbidden_path(fp):
        add_violation(VIOLATIONS_FILE, LOCK_FILE, f"forbidden:{fp}", 100)
        _deny(f"Forbidden write: {fp}")
    # Capability gate: overwriting/clearing a tracked credential that has no
    # verified replacement would break runtime capability.
    if cap_ledger.is_tracked(fp):
        decision = cap_ledger.removal_decision(fp)
        if "BLOCK" in decision:
            add_violation(VIOLATIONS_FILE, LOCK_FILE, f"capability:{fp}", 100)
            _deny(f"capability_ledger: {decision}")
        if "CONFIRM" in decision:
            _deny(f"[CONFIRM] capability_ledger: {decision}")


def cli():
    if sys.argv[1] == "init":
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        integrity_store(INTEGRITY_FILE, [Path(__file__).resolve()])
        print("[BACS] Initialized")
        sys.exit(0)
    elif sys.argv[1] == "unlock":
        clear_violations(VIOLATIONS_FILE, LOCK_FILE); safe_mode.reset()
        print("[BACS] Unlocked")
        sys.exit(0)
    elif sys.argv[1] == "status":
        v = load_violations(VIOLATIONS_FILE)
        print(f"[BACS] ws={window_score(v)} locked={should_lock(v)} assets={len(ledger._assets)} caps={len(cap_ledger._caps)}")
    elif sys.argv[1] == "capability-track" and len(sys.argv) >= 4:
        cap_ledger.track(sys.argv[2], sys.argv[3], dependents=sys.argv[4:])
        print(f"[BACS] tracked credential {sys.argv[2]} ({sys.argv[3]})")
        sys.exit(0)
    elif sys.argv[1] == "capability-verify" and len(sys.argv) >= 3:
        cap_ledger.mark_replacement_verified(sys.argv[2])
        print(f"[BACS] replacement verified for {sys.argv[2]} (CONFIRM until workflow passes)")
        sys.exit(0)
    elif sys.argv[1] == "capability-removable" and len(sys.argv) >= 3:
        cap_ledger.mark_removable(sys.argv[2])
        print(f"[BACS] {sys.argv[2]} marked removable")
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
