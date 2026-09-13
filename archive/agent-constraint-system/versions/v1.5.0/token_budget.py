#!/usr/bin/env python3
"""
token_budget.py v0.3.x — Multi-tier Compaction Reminder (PostToolUse hook)
Tiers: 100k/150k/200k/300k/350k/400k/450k/500k/550k/600k
Cooldown: 5min (warn tiers), 3min (urgent tiers)
"""

import json, os, sys, time
from pathlib import Path

HOME = Path.home()
STATE_FILE = HOME / ".claude" / "state" / "token_budget.json"
CHAR_TO_TOKEN = 0.25

# Multi-tier thresholds
TIERS = [
    (100_000, "NOTIFY", "\U0001f4a1", "Consider /compact", 300),
    (150_000, "WARN",   "\U0001f7e1", "Run /compact soon", 300),
    (200_000, "WARN",   "\U0001f7e1", "Compact recommended", 300),
    (300_000, "URGENT", "\U0001f534", "Run /compact NOW", 180),
    (350_000, "URGENT", "\U0001f534", "Context critical — /compact", 180),
    (400_000, "URGENT", "\U0001f534", "Heavy context — /compact NOW", 180),
    (450_000, "URGENT", "\U0001f534", "Context severe — compact or restart", 180),
    (500_000, "CRIT",   "\U00002620", "500k! /compact immediately", 120),
    (550_000, "CRIT",   "\U00002620", "550k! Cost exploding — compact", 120),
    (600_000, "CRIT",   "\U00002620", "600k! STOP and /compact", 120),
]


def _load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"total_tokens": 0, "tool_calls": 0, "tier_triggered": {}}


def _save_state(state):
    os.makedirs(STATE_FILE.parent, exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


def _estimate_tokens(text):
    return max(1, int(len(str(text)) * CHAR_TO_TOKEN))


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    state = _load_state()
    tool = data.get("tool_name", "")
    inp = data.get("tool_input", {})

    if tool == "Read":
        fp = inp.get("file_path", "")
        try:
            tokens_used = _estimate_tokens("x" * Path(fp).stat().st_size)
        except Exception:
            tokens_used = 100
    elif tool == "Write":
        tokens_used = _estimate_tokens(inp.get("content", ""))
    elif tool == "Bash":
        tokens_used = _estimate_tokens(inp.get("command", ""))
    elif tool == "Grep":
        tokens_used = _estimate_tokens(inp.get("pattern", "")) + 50
    elif tool == "Glob":
        tokens_used = _estimate_tokens(inp.get("pattern", "")) + 20
    else:
        tokens_used = 0

    state["total_tokens"] = state.get("total_tokens", 0) + tokens_used
    state["tool_calls"] = state.get("tool_calls", 0) + 1
    total = state["total_tokens"]
    triggered = state.get("tier_triggered", {})

    # Check tiers (highest matching, respecting per-tier cooldown)
    for threshold, label, emoji, msg, cooldown in reversed(TIERS):
        if total >= threshold:
            tier_key = str(threshold)
            last = triggered.get(tier_key, 0)
            if time.time() - last >= cooldown:
                lines = [
                    "",
                    f"{emoji} [{label}] Context: ~{total:,} tokens | {msg}",
                ]
                print("\n".join(lines), file=sys.stderr)
                triggered[tier_key] = time.time()
                state["tier_triggered"] = triggered
            break  # only fire highest tier

    _save_state(state)
    sys.exit(0)


if __name__ == "__main__":
    main()
