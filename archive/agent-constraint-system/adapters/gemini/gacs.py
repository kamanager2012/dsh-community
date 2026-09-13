#!/usr/bin/env python3
"""
gacs.py — Gemini CLI Adapter for Agent Constraint System (ACS)

Production-grade constraint layer for Gemini CLI.
Imports guard logic from acs_core/. Gemini's hook system is nearly identical
to Codex — same JSON stdin format, different event names:
  BeforeTool → PreToolUse
  AfterTool  → PostToolUse

CLI: gacs.py init | status | unlock --confirm | reset --force --confirm
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

CORE_DIR = os.path.join(Path.home(), ".acs_core")
sys.path.insert(0, CORE_DIR)

from acs_core import (
    check_bash, FORBIDDEN_ROOTS, is_forbidden_path,
    add_violation, clear_violations, should_lock, window_score, load_violations,
    integrity_store, integrity_verify, AuditLogger,
)

# ── Paths ────────────────────────────────────────────────────────────────────
GEMINI_DIR = Path.home() / ".gemini"
RUNTIME_DIR = GEMINI_DIR / "gacs_runtime"
VIOLATIONS_FILE = RUNTIME_DIR / "violations.json"
LOCK_FILE = RUNTIME_DIR / "LOCK.json"
INTEGRITY_FILE = RUNTIME_DIR / "integrity.json"
AUDIT_LOG = RUNTIME_DIR / "tool-audit.jsonl"
CRITICAL_FILES = [Path(__file__).resolve()]

audit = AuditLogger(AUDIT_LOG)


def _deny(reason: str) -> None:
    json.dump({"decision": "block", "reason": f"[GACS] {reason}"}, sys.stdout)
    sys.exit(0)


def handle_before_tool(data: dict) -> None:
    tool = data.get("tool_name", "")
    tool_input = data.get("tool_input", {})

    # Bash guard
    if tool in ("run_shell_command", "shell", "Bash", "execute_command"):
        cmd = tool_input.get("command", "")
        if not cmd:
            return
        if "gacs.py unlock" in cmd or ("gacs.py reset" in cmd and "--force" in cmd):
            return
        result = check_bash(cmd)
        if result:
            audit.log("BeforeTool", tool, data.get("session_id", ""), "deny", result)
            _deny(result)
        if should_lock(load_violations(VIOLATIONS_FILE)):
            _deny(f"System locked (window={window_score(load_violations(VIOLATIONS_FILE))})")

    # Write guard
    elif tool in ("write_file", "replace", "Write", "Edit"):
        fp = tool_input.get("file_path", "") or tool_input.get("filePath", "")
        if fp:
            root = is_forbidden_path(fp)
            if root:
                add_violation(VIOLATIONS_FILE, LOCK_FILE, f"forbidden: {fp}", 100)
                _deny(f"Write to {fp} (under {root}) is forbidden")
            if str(GEMINI_DIR / "hooks") in str(Path(fp).resolve()):
                add_violation(VIOLATIONS_FILE, LOCK_FILE, f"self_protect: {fp}", 100)
                _deny("Cannot modify GACS system files")


def cli() -> None:
    cmd = sys.argv[1]
    if cmd == "init":
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        integrity_store(INTEGRITY_FILE, CRITICAL_FILES)
        ok, msg = integrity_verify(INTEGRITY_FILE)
        print(f"[GACS] Initialized: {RUNTIME_DIR}")
        print(f"[GACS] Integrity: {msg}")
        sys.exit(0)
    elif cmd == "unlock":
        if "--confirm" not in sys.argv:
            print("[GACS] unlock requires --confirm", file=sys.stderr)
            sys.exit(1)
        clear_violations(VIOLATIONS_FILE, LOCK_FILE)
        audit.clear()
        print("[GACS] Unlocked.")
        sys.exit(0)
    elif cmd == "reset":
        if "--confirm" not in sys.argv:
            print("[GACS] reset requires --confirm", file=sys.stderr)
            sys.exit(1)
        if "--force" in sys.argv:
            for f in RUNTIME_DIR.glob("*"): f.unlink()
            print("[GACS] Full reset.")
        else:
            print("[GACS] Use --force to confirm.")
        sys.exit(0)
    elif cmd == "status":
        print("[ACS] Status Report")
        if not RUNTIME_DIR.exists():
            print("  NOT INITIALIZED (run init)")
            sys.exit(0)
        v = load_violations(VIOLATIONS_FILE)
        ok, msg = integrity_verify(INTEGRITY_FILE)
        print(f"  Violations: window={window_score(v)}, locked={should_lock(v)}")
        print(f"  Audit: {audit.total_count()} entries, {audit.denied_count()} denied")
        print(f"  Integrity: {msg}")
        sys.exit(0)


def main() -> None:
    if len(sys.argv) > 1:
        cli()
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    event = data.get("hook_event_name", "")
    if event in ("BeforeTool",):
        handle_before_tool(data)
    audit.log(event, data.get("tool_name", ""), data.get("session_id", ""), "allow")


if __name__ == "__main__":
    main()
