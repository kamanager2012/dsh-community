#!/usr/bin/env python3
"""
hacs.py — Hermes Agent Adapter for Agent Constraint System (ACS)

Hermes uses YAML-based hook configuration in ~/.hermes/config.yaml.
pre_tool_call = PreToolUse, post_tool_call = PostToolUse.
Block via stdout JSON: {"decision": "block", "reason": "..."}
Bash tool name is "terminal" (not "Bash").

CLI: hacs.py init | status | unlock --confirm | reset --force --confirm
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

HERMES_DIR = Path.home() / ".hermes"
HOOKS_DIR = HERMES_DIR / "agent-hooks"
RUNTIME_DIR = HERMES_DIR / "hacs_runtime"
VIOLATIONS_FILE = RUNTIME_DIR / "violations.json"
LOCK_FILE = RUNTIME_DIR / "LOCK.json"
INTEGRITY_FILE = RUNTIME_DIR / "integrity.json"
AUDIT_LOG = RUNTIME_DIR / "tool-audit.jsonl"

audit = AuditLogger(AUDIT_LOG)


def block(reason: str) -> None:
    """Hermes blocking: stdout JSON with exit 0"""
    json.dump({"decision": "block", "reason": f"[HACS] {reason}"}, sys.stdout)
    sys.exit(0)


def handle_pre_tool(data: dict) -> None:
    tool = data.get("tool_name", "")
    inp = data.get("tool_input", {})
    sid = data.get("session_id", "")

    # Hermes uses "terminal" for Bash, "write_file"/"patch" for writes
    if tool == "terminal":
        cmd = inp.get("command", "")
        if not cmd:
            return
        if "hacs.py unlock" in cmd or ("hacs.py reset" in cmd and "--force" in cmd):
            return
        result = check_bash(cmd)
        if result:
            audit.log("pre_tool_call", tool, sid, "deny", result)
            block(result)
        if should_lock(load_violations(VIOLATIONS_FILE)):
            block(f"System locked (window={window_score(load_violations(VIOLATIONS_FILE))})")

    elif tool in ("write_file", "patch", "write", "edit"):
        fp = inp.get("file_path", "") or inp.get("path", "")
        if fp:
            root = is_forbidden_path(fp)
            if root:
                add_violation(VIOLATIONS_FILE, LOCK_FILE, f"forbidden: {fp}", 100)
                block(f"Write to {fp} (under {root}) is forbidden")
            if str(HOOKS_DIR) in str(Path(fp).resolve()):
                add_violation(VIOLATIONS_FILE, LOCK_FILE, f"self_protect: {fp}", 100)
                block("Cannot modify HACS system files")


def cli() -> None:
    cmd = sys.argv[1]
    if cmd == "init":
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        integrity_store(INTEGRITY_FILE, [Path(__file__).resolve()])
        ok, msg = integrity_verify(INTEGRITY_FILE)
        print(f"[HACS] Initialized: {RUNTIME_DIR}")
        print(f"[HACS] Integrity: {msg}")
        sys.exit(0)
    elif cmd == "unlock":
        if "--confirm" not in sys.argv:
            print("[HACS] unlock requires --confirm", file=sys.stderr); sys.exit(1)
        clear_violations(VIOLATIONS_FILE, LOCK_FILE); audit.clear()
        print("[HACS] Unlocked."); sys.exit(0)
    elif cmd == "reset":
        if "--confirm" not in sys.argv:
            print("[HACS] reset requires --confirm", file=sys.stderr); sys.exit(1)
        if "--force" in sys.argv:
            for f in RUNTIME_DIR.glob("*"): f.unlink()
            print("[HACS] Full reset."); sys.exit(0)
        print("[HACS] Use --force."); sys.exit(0)
    elif cmd == "status":
        print("[ACS] Status Report")
        if not RUNTIME_DIR.exists():
            print("  NOT INITIALIZED (run init)"); sys.exit(0)
        v = load_violations(VIOLATIONS_FILE)
        ok, msg = integrity_verify(INTEGRITY_FILE)
        print(f"  Violations: window={window_score(v)}, locked={should_lock(v)}")
        print(f"  Audit: {audit.total_count()} entries, {audit.denied_count()} denied")
        print(f"  Integrity: {msg}"); sys.exit(0)


def main() -> None:
    if len(sys.argv) > 1:
        cli()
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    event = data.get("hook_event_name", "")
    if event == "pre_tool_call":
        handle_pre_tool(data)
    elif event == "post_tool_call":
        audit.log(event, data.get("tool_name", ""), data.get("session_id", ""), "allow")
    elif event == "on_session_start":
        if RUNTIME_DIR.exists():
            audit.log(event, "", data.get("session_id", ""), "init")
    elif event == "on_session_end":
        audit.log(event, "", data.get("session_id", ""), "stop")

    # All other events: allow (empty stdout = no-op)
    sys.exit(0)


if __name__ == "__main__":
    main()
