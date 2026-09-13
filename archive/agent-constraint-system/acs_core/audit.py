# acs_core/audit.py — Agent-agnostic audit logging
# JSONL audit trail for all ACS adapter variants.

import json
import time
from pathlib import Path
from typing import Any, Dict


class AuditLogger:
    """Writes JSONL audit entries. Does NOT auto-create directories."""

    def __init__(self, log_path: Path):
        self.log_path = log_path
        self.enabled = log_path.parent.exists()

    def log(self, event: str, tool_name: str, session_id: str,
            outcome: str, detail: str = "") -> None:
        if not self.enabled:
            return
        try:
            entry = {
                "ts": time.time(),
                "event": event,
                "tool": tool_name,
                "session": session_id,
                "outcome": outcome,
                "detail": detail,
            }
            with open(self.log_path, "a") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception:
            pass

    def clear(self) -> None:
        self.log_path.unlink(missing_ok=True)

    def entries(self) -> list[Dict[str, Any]]:
        if not self.log_path.exists():
            return []
        entries = []
        with open(self.log_path) as f:
            for line in f:
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return entries

    def _counts(self) -> tuple[int, int]:
        """Single-pass count of (total, denied). Avoids re-parsing JSONL twice."""
        total = 0
        denied = 0
        if not self.log_path.exists():
            return 0, 0
        with open(self.log_path) as f:
            for line in f:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                total += 1
                if entry.get("outcome") == "deny":
                    denied += 1
        return total, denied

    def denied_count(self) -> int:
        return self._counts()[1]

    def total_count(self) -> int:
        return self._counts()[0]
