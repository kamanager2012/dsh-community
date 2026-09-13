#!/usr/bin/env python3
"""
acs_orchestrator.py -- Per-Agent ACS Orchestrator (v2.1)

Each agent deploys its own copy of this orchestrator to its hooks directory.
Auto-detects agent identity from __file__ path. All state (violations, locks,
audit) is per-agent — no shared state between agents.

Architecture:
  Agent settings -> single hook entry -> acs_orchestrator.py (per-agent)
                  -> agent-specific adapter (violations/lock/audit)
                  -> shared stateless guards (sed_guard, abi_guard, ...)
"""
from __future__ import annotations

import json, os, subprocess, sys
from pathlib import Path

# ── Agent-specific bypass: never gate Cursor or Grok sessions ──
# These agents read Claude's hook config but have their own runtimes.
_e = os.environ
if _e.get("CURSOR_PROJECT_DIR") or _e.get("CURSOR_VERSION") or _e.get("CURSOR_AGENT"):
    raise SystemExit(0)
if _e.get("GROK_TELEMETRY_TRACE_UPLOAD") is not None:
    raise SystemExit(0)

_AGENT_DIR = Path(__file__).resolve().parent
_HOME = Path.home()

AGENT_MAP = {
    str(_HOME / ".claude" / "hooks"):          "claude",
    str(_HOME / ".codebuddy" / "hooks"):      "codebuddy",
    str(_HOME / ".codex" / "hooks"):           "codex",
    str(_HOME / ".hermes" / "agent-hooks"):    "hermes",
    str(_HOME / ".qoder-cn" / "hooks"):          "qoder",
}

TOOL_ALIAS = {
    "terminal":           "Bash",
    "execute_command":    "Bash",
    "run_shell_command":  "Bash",
    "write_file":         "Write",
    "patch":              "Edit",
    "replace":            "Edit",
    "apply_patch":        "Edit",
    "MultiEdit":          "Edit",
    "read_file":          "Read",
}

EVENT_ALIAS = {
    "pre_tool_call":     "PreToolUse",
    "post_tool_call":    "PostToolUse",
    "on_session_end":    "Stop",
}

AGENT = AGENT_MAP.get(str(_AGENT_DIR), "unknown")
SHARED = _HOME / ".codebuddy" / "hooks"

ADAPTER = {
    "codebuddy": "acs_lite.py",
    "codex":     "acs_codex.py",
    "hermes":    "hacs.py",
    "qoder":     "qacs.py",
}.get(AGENT, "acs_lite.py")

DISPATCH = {
    "PreToolUse": {
        "Bash":  [ADAPTER, "sed_guard.py", "filesystem_guard.py"],
        "Write": [ADAPTER, "filesystem_guard.py"],
        "Edit":  [ADAPTER, "filesystem_guard.py"],
        "Read":  ["read_guard.py"],
    },
    "PostToolUse": {
        "Bash":  [ADAPTER, "abi_guard.py", "token_budget.py", "risk_engine.py assess --stdin"],
        "Write": [ADAPTER, "abi_guard.py", "token_budget.py", "risk_engine.py assess --stdin", "proposal_guard.py"],
        "Edit":  [ADAPTER, "abi_guard.py", "token_budget.py", "risk_engine.py assess --stdin", "proposal_guard.py"],
    },
    "Stop": {
        "*": [f"{ADAPTER} status", "stability_report.py check", "runtime_loop.py tick --reason session_end"],
    },
}


def _resolve_guards(event: str, tool: str) -> list[str]:
    config = DISPATCH.get(event, {})
    return config.get(tool) or config.get("*", [])


def _run_guard(entry: str, stdin_data: str) -> int:
    parts = entry.split()
    name = parts[0]; args = parts[1:] if len(parts) > 1 else []

    if name == ADAPTER:
        script = _AGENT_DIR / name
    else:
        script = SHARED / name

    if not script.exists():
        return 0

    try:
        r = subprocess.run(
            [sys.executable, str(script)] + args,
            input=stdin_data, text=True, capture_output=True, timeout=10)
        if r.returncode == 2:
            return 2  # Explicit deny
        if r.returncode != 0:
            # Exit 1 (or other non-zero) = guard error -> fail-closed
            err = (r.stderr or r.stdout).strip()
            print(f"[ORCH:{AGENT}] {name} guard error (exit={r.returncode}), DENYING: {err[:200]}",
                  file=sys.stderr)
            return 2
        return 0
    except subprocess.TimeoutExpired:
        print(f"[ORCH:{AGENT}] {name} timeout, DENYING (fail-closed)", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"[ORCH:{AGENT}] {name} exception, DENYING (fail-closed): {e}", file=sys.stderr)
        return 2


def main() -> None:
    try:       data = json.load(sys.stdin)
    except:    sys.exit(0)

    raw_event = data.get("hook_event_name", "")
    event = EVENT_ALIAS.get(raw_event, raw_event)
    raw_tool = data.get("tool_name", "")
    tool = TOOL_ALIAS.get(raw_tool, raw_tool)

    guards = _resolve_guards(event, tool)
    if not guards:
        sys.exit(0)

    stdin_data = json.dumps(data)
    for entry in guards:
        if _run_guard(entry, stdin_data) == 2:
            sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
