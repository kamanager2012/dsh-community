"""Unit tests for the violation scoring / locking / integrity chain.

This is the most safety-critical path in ACS (lock decisions gate all hook
writes) and previously had zero test coverage. Run with pytest.
"""
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "acs_core"))

from violations import (
    WINDOW_THRESHOLD,
    LOCK_DENY_SCORE,
    add_violation,
    clear_violations,
    integrity_store,
    integrity_verify,
    should_lock,
    total_score,
    window_score,
)


def _ev(score, ts, pinned=False):
    return {"ts": ts, "score": score, "reason": "test", "pinned": pinned}


def test_window_score_counts_fresh_events():
    now = time.time()
    v = {"events": [_ev(25, now) for _ in range(4)]}
    assert window_score(v) == 100


def test_window_score_expires_old_events():
    now = time.time()
    v = {"events": [_ev(100, now - 3601)]}
    assert window_score(v) == 0


def test_window_score_no_longer_capped_at_10_events():
    """Regression: 10 x WRITE(25) = 250 < threshold 300, so the most common
    violation class could never trigger a window lock."""
    now = time.time()
    v = {"events": [_ev(25, now) for _ in range(12)]}
    assert window_score(v) == 300
    assert should_lock(v)


def test_pinned_events_count_forever():
    """Regression: a pinned SYSTEM(100) event pushed out of the old last-10
    window stopped contributing. Pinned must persist regardless of volume."""
    now = time.time()
    v = {"events": [_ev(100, now, pinned=True)] + [_ev(25, now) for _ in range(20)]}
    assert window_score(v) == 100 + 20 * 25


def test_total_score_counts_everything():
    now = time.time()
    v = {"events": [_ev(25, now - 10000), _ev(100, now, pinned=True), _ev(25, now)]}
    assert total_score(v) == 150


def test_add_violation_locks_at_threshold():
    tmp = Path(tempfile.mkdtemp())
    vfile = tmp / "violations.json"
    lfile = tmp / "lock.json"
    ws = locked = None
    report = None
    for i in range(12):
        ws, locked, report = add_violation(vfile, lfile, f"write-{i}", 25)
    assert ws >= WINDOW_THRESHOLD
    assert locked
    assert lfile.exists()
    assert report["_persist_ok"] is True


def test_add_violation_deny_score_locks_immediately():
    tmp = Path(tempfile.mkdtemp())
    vfile = tmp / "violations.json"
    lfile = tmp / "lock.json"
    ws, locked, report = add_violation(vfile, lfile, "deny", LOCK_DENY_SCORE)
    assert locked
    assert ws >= WINDOW_THRESHOLD


def test_add_violation_persists_events():
    tmp = Path(tempfile.mkdtemp())
    vfile = tmp / "violations.json"
    lfile = tmp / "lock.json"
    _, _, report1 = add_violation(vfile, lfile, "first", 25)
    _, _, report2 = add_violation(vfile, lfile, "second", 25)
    # _persist_ok is a process-local flag on the returned report (not written
    # to disk with the event stream)
    assert report1["_persist_ok"] is True
    assert report2["_persist_ok"] is True
    reloaded = __import__("violations").load_violations(vfile)
    assert len(reloaded["events"]) == 2


def test_clear_violations_removes_files():
    tmp = Path(tempfile.mkdtemp())
    vfile = tmp / "violations.json"
    lfile = tmp / "lock.json"
    add_violation(vfile, lfile, "x", 25)
    assert vfile.exists()
    clear_violations(vfile, lfile)
    assert not vfile.exists()
    assert not lfile.exists()


def test_integrity_store_verify_roundtrip():
    tmp = Path(tempfile.mkdtemp())
    f = tmp / "integrity.json"
    critical = [tmp / "a.txt", tmp / "b.txt"]
    for p in critical:
        p.write_text("content")
    integrity_store(f, critical)
    ok, msg = integrity_verify(f)
    assert ok, msg
    assert "chain ok" in msg


def test_integrity_verify_detects_tampering():
    tmp = Path(tempfile.mkdtemp())
    f = tmp / "integrity.json"
    critical = [tmp / "a.txt"]
    (tmp / "a.txt").write_text("content")
    integrity_store(f, critical)
    # Tamper with the stored hash
    import json
    entries = json.loads(f.read_text())
    entries[0]["entry_hash"] = "deadbeef"
    f.write_text(json.dumps(entries))
    ok, msg = integrity_verify(f)
    assert not ok
    assert "hash mismatch" in msg


def test_integrity_compact_keeps_chain_valid():
    tmp = Path(tempfile.mkdtemp())
    f = tmp / "integrity.json"
    critical = [tmp / "a.txt"]
    (tmp / "a.txt").write_text("content")
    # Write more than MAX_CHAIN_ENTRIES snapshots to force compaction
    from violations import MAX_CHAIN_ENTRIES
    for _ in range(MAX_CHAIN_ENTRIES + 5):
        integrity_store(f, critical)
    ok, msg = integrity_verify(f)
    assert ok, msg
