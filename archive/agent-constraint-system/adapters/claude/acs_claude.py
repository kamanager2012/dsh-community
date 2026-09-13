#!/usr/bin/env python3
"""
acs_claude.py -- Claude Code Adapter

Imports from acs_core. Claude is just another adapter, not the canonical source.
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

CLAUDE_DIR = Path.home() / ".claude"
RUNTIME_DIR = CLAUDE_DIR / "runtime"
VIOLATIONS_FILE = RUNTIME_DIR / "VIOLATIONS.json"
LOCK_FILE = RUNTIME_DIR / "LOCKED"
INTEGRITY_FILE = RUNTIME_DIR / "INTEGRITY.json"
AUDIT_LOG = RUNTIME_DIR / "tool-audit.jsonl"

audit = AuditLogger(AUDIT_LOG)
ledger = AssetLedger(str(RUNTIME_DIR / "asset_ledger.json"))
cap_ledger = CapabilityLedger(str(RUNTIME_DIR / "capability_ledger.json"))
safe_mode = SafeMode(str(RUNTIME_DIR / "safe_mode.json"))


def _deny(reason):
    json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": f"[ACS] {reason}"}}, sys.stdout)
    sys.exit(0)


def handle_bash(data):
    cmd = data.get("tool_input", {}).get("command", "").strip()
    if not cmd:
        return
    # Exact-match bypass for unlock/reset CLI (substring match is a bypass vector)
    tokens = cmd.split()
    if len(tokens) >= 2 and tokens[-2] == "unlock" and "--confirm" in tokens:
        return
    if len(tokens) >= 3 and tokens[-3] == "reset" and "--force" in tokens and "--confirm" in tokens:
        return
    result = check_bash_with_context(cmd, asset_ledger=ledger, error_count=safe_mode.error_count(), capability_ledger=cap_ledger)
    if result["decision"] == "BLOCK":
        audit.log("PreToolUse", "Bash", data.get("session_id", ""), "deny", result["reason"])
        ws, locked, _ = add_violation(VIOLATIONS_FILE, LOCK_FILE, f"dangerous_command:{cmd[:200]}", 100)
        _deny(result["reason"])
    elif result["decision"] == "CONFIRM":
        audit.log("PreToolUse", "Bash", data.get("session_id", ""), "confirm", result["reason"])
        _deny(f"[CONFIRM] {result['reason']}")
    if should_lock(load_violations(VIOLATIONS_FILE)):
        _deny(f"System locked (window={window_score(load_violations(VIOLATIONS_FILE))})")


def handle_write(data):
    fp = data.get("tool_input", {}).get("file_path", "")
    if not fp:
        return
    root = is_forbidden_path(fp)
    if root:
        ws, locked, _ = add_violation(VIOLATIONS_FILE, LOCK_FILE, f"forbidden:{fp}", 100)
        _deny(f"Write to {fp} (under {root}) forbidden")
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
    cmd = sys.argv[1]
    if cmd == "init":
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        integrity_store(INTEGRITY_FILE, [Path(__file__).resolve()])
        print("[ACS Claude] Initialized with Asset Ledger + Safe Mode")
        sys.exit(0)
    elif cmd == "unlock":
        clear_violations(VIOLATIONS_FILE, LOCK_FILE)
        safe_mode.reset()
        audit.clear()
        print("[ACS Claude] Unlocked")
        sys.exit(0)
    elif cmd == "status":
        v = load_violations(VIOLATIONS_FILE)
        ws, locked = window_score(v), should_lock(v)
        ok, msg = integrity_verify(INTEGRITY_FILE)
        print(f"[ACS Claude] ws={ws} locked={locked} integrity={msg} assets={len(ledger._assets)} caps={len(cap_ledger._caps)} safe={safe_mode.is_active()}")
        sys.exit(0)
    elif cmd == "capability-track" and len(sys.argv) >= 4:
        # capability-track <path> <secret_id> [dependent...]
        cap_ledger.track(sys.argv[2], sys.argv[3], dependents=sys.argv[4:])
        print(f"[ACS Claude] tracked credential {sys.argv[2]} ({sys.argv[3]})")
        sys.exit(0)
    elif cmd == "capability-verify" and len(sys.argv) >= 3:
        # capability-verify <path>  (marks replacement verified — CONFIRM gate)
        cap_ledger.mark_replacement_verified(sys.argv[2])
        print(f"[ACS Claude] replacement verified for {sys.argv[2]} (CONFIRM until workflow passes)")
        sys.exit(0)
    elif cmd == "capability-removable" and len(sys.argv) >= 3:
        # capability-removable <path>  (marks old credential safe to remove)
        cap_ledger.mark_removable(sys.argv[2])
        print(f"[ACS Claude] {sys.argv[2]} marked removable")
        sys.exit(0)


def main():
    if len(sys.argv) > 1:
        cli()
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    event, tool = data.get("hook_event_name", ""), data.get("tool_name", "")
    if event == "PreToolUse":
        if tool == "Bash": handle_bash(data)
        elif tool in ("Write", "Edit"): handle_write(data)


if __name__ == "__main__":
    main()
