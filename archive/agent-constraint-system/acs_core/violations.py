# acs_core/violations.py — Agent-agnostic violation tracking
# Sliding window, integrity chain, lock mechanism.
# Used by all ACS adapter variants.

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Tuple

# ── Constants ────────────────────────────────────────────────────────────────

WINDOW_DECAY_SECONDS = 3600  # 1 hour
WINDOW_THRESHOLD = 300
LOCK_DENY_SCORE = 1000
MAX_CHAIN_ENTRIES = 1000
COMPACTION_KEEP = 500


def _save(path: Path, data: Any) -> bool:
    """Atomic write with tmp file, cleaned on failure."""
    tmp_path = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=path.parent, prefix=".tmp_", suffix=".json")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            os.replace(tmp_path, path)
            return True
        except (OSError, PermissionError):
            return False
    except Exception:
        return False
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _load(path: Path, default: Any) -> Any:
    """Load JSON, return default on failure."""
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return default


# ── Violation tracking ──────────────────────────────────────────────────────

def load_violations(violations_file: Path) -> Dict[str, Any]:
    return _load(violations_file, {"events": []})


def save_violations(violations_file: Path, data: Dict[str, Any]) -> bool:
    return _save(violations_file, data)


def window_score(violations: Dict[str, Any]) -> int:
    """Compute score within the sliding window.

    Every event younger than WINDOW_DECAY_SECONDS counts (no fixed event-count
    cap — with a 10-entry cap, 10 × WRITE(25) = 250 < WINDOW_THRESHOLD(300),
    so the most common violation class could never trigger a window lock).
    Pinned events count forever: they are the "never expires" marker and must
    not be pushed out by newer events.
    """
    events = violations.get("events", [])
    if not events:
        return 0
    now = time.time()
    total = 0
    for e in events:
        if e.get("pinned", False):
            total += e.get("score", 0)
        elif now - e.get("ts", 0) < WINDOW_DECAY_SECONDS:
            total += e.get("score", 0)
    return total


def total_score(violations: Dict[str, Any]) -> int:
    """Total score across all events."""
    return sum(e.get("score", 0) for e in violations.get("events", []))


def should_lock(violations: Dict[str, Any]) -> bool:
    """Check if window score exceeds lock threshold."""
    return window_score(violations) >= WINDOW_THRESHOLD


def add_violation(
    violations_file: Path,
    lock_file: Path,
    reason: str,
    score: int,
) -> Tuple[int, bool, Dict[str, Any]]:
    """Add a violation event. Returns (new_window_score, is_locked, report).

    The report dict carries a ``_persist_ok`` flag: if persisting the event
    failed (disk full / permissions), the caller can see it — a lock decision
    made on in-memory state alone would not survive a restart, and should not
    look like a normal, durable record. The lock file is still written when
    the threshold is crossed, because the process-local session is locked
    either way.
    """
    v = load_violations(violations_file)
    event = {
        "ts": time.time(),
        "score": score,
        "reason": reason,
        "pinned": False,
    }
    v.setdefault("events", []).append(event)
    persist_ok = save_violations(violations_file, v)
    v["_persist_ok"] = persist_ok
    ws = window_score(v)
    locked = ws >= WINDOW_THRESHOLD or score >= LOCK_DENY_SCORE
    if locked:
        _save(lock_file, {"ts": time.time(), "score": ws, "reason": reason})
    return (ws, locked, v)


def clear_violations(violations_file: Path, lock_file: Path) -> None:
    violations_file.unlink(missing_ok=True)
    lock_file.unlink(missing_ok=True)


# ── Integrity chain ─────────────────────────────────────────────────────────

def _compute_entry_hash(entry: Dict[str, Any]) -> str:
    parts = [
        entry.get("snapshot_id", ""),
        str(entry.get("timestamp", 0)),
    ]
    file_hashes = {k: v for k, v in entry.items()
                   if k not in {"snapshot_id", "timestamp", "version", "parent",
                                "created_by", "entry_hash"}}
    for k in sorted(file_hashes.keys()):
        parts.append(f"{k}={file_hashes[k]}")
    parts.append(f"parent={entry.get('parent', 'genesis')}")
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]


def integrity_snapshot(critical_files: List[Path]) -> Dict[str, Any]:
    """Create integrity snapshot of critical files."""
    file_hashes = {}
    for p in critical_files:
        if p.exists():
            h = hashlib.sha256(p.read_bytes()).hexdigest()[:12]
            file_hashes[str(p)] = h
    return {
        "snapshot_id": str(uuid.uuid4()),
        "timestamp": time.time(),
        "file_hashes": file_hashes,
    }


def _compact_chain(entries: List[Dict[str, Any]], keep: int) -> List[Dict[str, Any]]:
    compact_count = len(entries) - keep
    if compact_count <= 0:
        return entries
    pruned = entries[:compact_count]
    compact_entry: Dict[str, Any] = {
        "snapshot_id": f"compacted-{compact_count}-entries",
        "timestamp": time.time(),
        "created_by": "compactor",
        "parent": pruned[0].get("parent", "genesis"),
        "_compacted": True,
        "_compacted_count": compact_count,
        "_first_timestamp": pruned[0].get("timestamp", 0),
        "_last_timestamp": pruned[-1].get("timestamp", 0),
        "_compacted_hash": pruned[-1].get("entry_hash", ""),
    }
    compact_entry["entry_hash"] = _compute_entry_hash(compact_entry)
    result = [compact_entry]
    for entry in entries[compact_count:]:
        entry["parent"] = result[-1]["entry_hash"]
        entry["entry_hash"] = _compute_entry_hash(entry)
        result.append(entry)
    return result


def integrity_store(
    integrity_file: Path,
    critical_files: List[Path],
) -> Dict[str, Any]:
    """Store new integrity snapshot, compact if needed."""
    entries = _load(integrity_file, [])
    if isinstance(entries, dict):
        entries = [{"_migrated_from": "v0.3.x", "_timestamp": entries.get("_timestamp", 0)}]
    new_entry = integrity_snapshot(critical_files)
    new_entry["parent"] = entries[-1].get("entry_hash", "genesis") if entries else "genesis"
    new_entry["created_by"] = "terminal"
    new_entry["entry_hash"] = _compute_entry_hash(new_entry)
    entries.append(new_entry)
    if len(entries) > MAX_CHAIN_ENTRIES:
        entries = _compact_chain(entries, keep=COMPACTION_KEEP)
    _save(integrity_file, entries)
    return new_entry


def integrity_verify(integrity_file: Path) -> Tuple[bool, str]:
    """Verify integrity chain. Returns (ok, message)."""
    entries = _load(integrity_file, [])
    if isinstance(entries, dict) or not entries:
        return False, "no baseline — run integrity-store first"
    prev_hash = "genesis"
    for idx, entry in enumerate(entries):
        if entry.get("parent", "genesis") != prev_hash:
            return False, f"chain broken at entry {idx}: parent mismatch"
        expected = _compute_entry_hash(entry)
        actual = entry.get("entry_hash", "MISSING")
        if actual == "MISSING":
            return False, f"chain broken at entry {idx}: missing hash"
        elif actual != expected:
            return False, f"chain broken at entry {idx}: hash mismatch"
        prev_hash = actual
    return True, f"chain ok ({len(entries)} entries, hash verified)"
