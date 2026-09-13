#!/usr/bin/env python3
"""
qacs.py -- Qoder CN CLI Adapter (ACS)

Qoder's hook system is nearly identical to Codex CLI. Same JSON stdin format,
same exit codes (0=allow, 2=block). Paths: ~/.qoder-cn/ instead of ~/.codex/.

CLI: qacs.py init | status | unlock --confirm | reset --force --confirm
"""
from __future__ import annotations

import json, os, sys
from pathlib import Path

sys.path.insert(0, os.path.join(Path.home(), ".acs_core"))

from guard import check_bash
from paths import FORBIDDEN_ROOTS, is_forbidden_path
from violations import (
    add_violation, clear_violations, should_lock, window_score, load_violations,
    integrity_store, integrity_verify,
)
from audit import AuditLogger

QODER_DIR = Path.home() / ".qoder-cn"
HOOKS_DIR = QODER_DIR / "hooks"
RUNTIME_DIR = QODER_DIR / "qacs_runtime"
VIOLATIONS_FILE = RUNTIME_DIR / "violations.json"
LOCK_FILE = RUNTIME_DIR / "LOCK.json"
INTEGRITY_FILE = RUNTIME_DIR / "integrity.json"
AUDIT_LOG = RUNTIME_DIR / "tool-audit.jsonl"

audit = AuditLogger(AUDIT_LOG)


def _deny(reason: str) -> None:
    json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": f"[QACS] {reason}"}}, sys.stdout)
    sys.exit(0)


def handle_bash(data: dict) -> None:
    cmd = data.get("tool_input", {}).get("command", "")
    if not cmd: return
    if "qacs.py unlock" in cmd or ("qacs.py reset" in cmd and "--force" in cmd): return
    result = check_bash(cmd)
    if result:
        audit.log("PreToolUse", "Bash", data.get("session_id", ""), "deny", result)
        ws, locked, _ = add_violation(VIOLATIONS_FILE, LOCK_FILE, f"dangerous_command:{cmd[:200]}", 100)
        _deny(result)
    if should_lock(load_violations(VIOLATIONS_FILE)):
        _deny(f"System locked (window={window_score(load_violations(VIOLATIONS_FILE))})")


def handle_write(data: dict) -> None:
    fp = data.get("tool_input", {}).get("file_path", "")
    if not fp: return
    root = is_forbidden_path(fp)
    if root:
        add_violation(VIOLATIONS_FILE, LOCK_FILE, f"forbidden: {fp}", 100)
        audit.log("PreToolUse", data.get("tool_name", ""), data.get("session_id", ""), "deny", f"forbidden_root: {root}")
        _deny(f"Write to {fp} (under {root}) is forbidden")
    if str(HOOKS_DIR) in str(Path(fp).resolve()):
        add_violation(VIOLATIONS_FILE, LOCK_FILE, f"self_protect: {fp}", 100)
        _deny("Cannot modify QACS system files")


def cli() -> None:
    cmd = sys.argv[1]
    if cmd == "init":
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        integrity_store(INTEGRITY_FILE, [Path(__file__).resolve()])
        ok, msg = integrity_verify(INTEGRITY_FILE)
        print(f"[QACS] Initialized: {RUNTIME_DIR}")
        print(f"[QACS] Integrity: {msg}"); sys.exit(0)
    elif cmd == "unlock":
        if "--confirm" not in sys.argv: print("[QACS] unlock requires --confirm", file=sys.stderr); sys.exit(1)
        clear_violations(VIOLATIONS_FILE, LOCK_FILE); audit.clear()
        print("[QACS] Unlocked."); sys.exit(0)
    elif cmd == "reset":
        if "--confirm" not in sys.argv: print("[QACS] reset requires --confirm", file=sys.stderr); sys.exit(1)
        if "--force" in sys.argv:
            for f in RUNTIME_DIR.glob("*"): f.unlink()
            print("[QACS] Full reset."); sys.exit(0)
        print("[QACS] Use --force."); sys.exit(0)
    elif cmd == "status":
        print("[QACS] Status Report")
        if not RUNTIME_DIR.exists(): print("  NOT INITIALIZED (run init)"); sys.exit(0)
        v = load_violations(VIOLATIONS_FILE)
        ok, msg = integrity_verify(INTEGRITY_FILE)
        print(f"  Violations: window={window_score(v)}, locked={should_lock(v)}")
        print(f"  Audit: {audit.total_count()} entries, {audit.denied_count()} denied")
        print(f"  Integrity: {msg}"); sys.exit(0)


def main() -> None:
    if len(sys.argv) > 1: cli()
    try: data = json.load(sys.stdin)
    except: sys.exit(0)
    event = data.get("hook_event_name", "")
    tool = data.get("tool_name", "")
    if event == "PreToolUse":
        if tool == "Bash": handle_bash(data)
        elif tool in ("Write", "Edit", "MultiEdit"): handle_write(data)
    elif event == "PostToolUse":
        audit.log(event, tool, data.get("session_id", ""), "allow")
    elif event == "Stop":
        audit.log(event, tool, data.get("session_id", ""), "stop")


if __name__ == "__main__":
    main()
