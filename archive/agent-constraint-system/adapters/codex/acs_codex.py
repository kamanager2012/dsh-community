#!/usr/bin/env python3
"""
acs_codex.py -- Codex CLI Adapter for Agent Constraint System (ACS)

Production-grade constraint layer for Codex CLI with Asset Ledger
and Post-Error Safe Mode support.

Hook events: PreToolUse (Bash/Write), PostToolUse (audit),
             SessionStart (init), Stop (session end)

CLI: acs_codex.py init | status | unlock --confirm | reset --force --confirm
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Find and import shared core
CORE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "acs_core")
if not os.path.isdir(CORE_DIR):
    CORE_DIR = os.path.join(Path.home(), ".acs_core")
sys.path.insert(0, CORE_DIR)

from guard import check_bash, check_bash_with_context
from paths import FORBIDDEN_ROOTS, is_forbidden_path, is_self_protect
from violations import (
    add_violation, clear_violations, window_score, should_lock,
    load_violations, integrity_store, integrity_verify,
)
from audit import AuditLogger
from asset_ledger import AssetLedger, AssetTracker
from safe_mode import SafeMode

# -- Agent-specific paths --
CODEX_DIR = Path.home() / ".codex"
HOOKS_DIR = Path(__file__).resolve().parent
RUNTIME_DIR = CODEX_DIR / "cacs_runtime"
VIOLATIONS_FILE = RUNTIME_DIR / "violations.json"
LOCK_FILE = RUNTIME_DIR / "LOCK.json"
INTEGRITY_FILE = RUNTIME_DIR / "integrity.json"
AUDIT_LOG = RUNTIME_DIR / "tool-audit.jsonl"
CRITICAL_FILES = [Path(__file__).resolve()]

audit = AuditLogger(AUDIT_LOG)
ledger = AssetLedger(str(RUNTIME_DIR / "asset_ledger.json"))
tracker = AssetTracker(ledger)
safe_mode = SafeMode(str(RUNTIME_DIR / "safe_mode.json"))


# -- Helper --
def _deny(reason: str) -> None:
    json.dump({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"[CACS] {reason}",
        }
    }, sys.stdout)
    sys.exit(0)


# -- Event Handlers --

def handle_bash(data: dict) -> None:
    command = data.get("tool_input", {}).get("command", "")
    if not command:
        return

    cmd = command.strip()
    # Always allow unlock/reset (whitelist)
    if "acs_codex.py unlock" in cmd or ("acs_codex.py reset" in cmd and "--force" in cmd):
        return

    # Level 1 + 2 + 3: pattern + asset + safe_mode
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

# Violation check: if locked, deny
    if should_lock(load_violations(VIOLATIONS_FILE)):
        ws = window_score(load_violations(VIOLATIONS_FILE))
        _deny(f"System locked (violation window={ws})")


def handle_write(data: dict) -> None:
    fp = data.get("tool_input", {}).get("file_path", "")
    if not fp:
        return

    # Forbidden root check
    root = is_forbidden_path(fp)
    if root:
        ws, locked, _ = add_violation(VIOLATIONS_FILE, LOCK_FILE, f"forbidden: {fp}", 100)
        audit.log("PreToolUse", data.get("tool_name", ""), data.get("session_id", ""),
                  "deny", f"forbidden_root: {root}")
        _deny(f"Write to {fp} (under {root}) is forbidden")

    # Auto-track: record the write in asset ledger
    tracker.on_write(fp)

    # Self-protection
    if str(HOOKS_DIR) in str(Path(fp).resolve()):
        ws, locked, _ = add_violation(VIOLATIONS_FILE, LOCK_FILE, f"self_protect: {fp}", 100)
        _deny("Cannot modify CACS system files")


def handle_session_start(data: dict) -> None:
    if RUNTIME_DIR.exists():
        audit.log("SessionStart", "", data.get("session_id", ""), "init")


# -- CLI --

def cli() -> None:
    cmd = sys.argv[1]
    if cmd == "init":
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        integrity_store(INTEGRITY_FILE, CRITICAL_FILES)
        ok, msg = integrity_verify(INTEGRITY_FILE)
        print(f"[ACS] Initialized: {RUNTIME_DIR}")
        print(f"[ACS] Integrity: {msg}")
        print(f"[ACS] Asset Ledger: active ({ledger._storage_path})")
        print(f"[ACS] Safe Mode: threshold={safe_mode.threshold} errors")
        sys.exit(0)

    elif cmd == "unlock":
        if "--confirm" not in sys.argv:
            print("[CACS] unlock requires explicit human authorization.", file=sys.stderr)
            print("[CACS] Run: acs_codex.py unlock --confirm", file=sys.stderr)
            sys.exit(1)
        clear_violations(VIOLATIONS_FILE, LOCK_FILE)
        safe_mode.reset()
        audit.clear()
        print("[CACS] Unlocked. Violations, safe mode, and audit cleared.")
        sys.exit(0)

    elif cmd == "reset":
        if "--confirm" not in sys.argv:
            print("[CACS] reset requires explicit human authorization.", file=sys.stderr)
            print("[CACS] Run: acs_codex.py reset --force --confirm", file=sys.stderr)
            sys.exit(1)
        if "--force" in sys.argv:
            for f in RUNTIME_DIR.glob("*"):
                f.unlink()
            ledger.clear()
            safe_mode.reset()
            print("[CACS] Full reset -- all runtime state cleared.")
        else:
            print("[CACS] Use --force to confirm full reset.")
        sys.exit(0)

    elif cmd == "status":
        print("[ACS] Status Report")
        if not RUNTIME_DIR.exists():
            print("  Status: NOT INITIALIZED (run init first)")
            sys.exit(0)
        v = load_violations(VIOLATIONS_FILE)
        ws = window_score(v)
        locked = should_lock(v)
        ok, msg = integrity_verify(INTEGRITY_FILE)
        print(f"  Violations: window_score={ws}, locked={locked}")
        print(f"  Audit: {audit.total_count()} entries, {audit.denied_count()} denied")
        print(f"  Integrity: {msg}")
        print(f"  Safe Mode: active={safe_mode.is_active()}, errors={safe_mode.error_count()}")
        print(f"  Asset Ledger: {len(ledger._assets)} tracked assets")
        sys.exit(0)


# -- Main --

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
        elif tool in ("Write", "Edit", "MultiEdit", "apply_patch"):
            handle_write(data)
    elif event == "PostToolUse":
        audit.log(event, tool, data.get("session_id", ""), "allow")
        resp = data.get("tool_response", "")
        if isinstance(resp, str) and resp:
            audit.log(event, tool, data.get("session_id", ""), "allow",
                      f"response_size: {len(resp)}")
    elif event == "SessionStart":
        handle_session_start(data)
    elif event == "Stop":
        audit.log(event, tool, data.get("session_id", ""), "stop")


if __name__ == "__main__":
    main()
