"""Unit tests for the shared KeyedJsonLedger base and both ledger types:
cross-process save merging, forward-tolerant loading, capability state
machine (no jumps), asset decision purity. Run with pytest.
"""
import json
import multiprocessing
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "acs_core"))

from asset_ledger import AssetLedger
from capability_ledger import CapabilityLedger
from ledger_base import KeyedJsonLedger


# ── AssetLedger ─────────────────────────────────────────────────────────────

def test_asset_track_and_decision():
    tmp = Path(tempfile.mkdtemp())
    l = AssetLedger(str(tmp / "assets.json"))
    l.track("/tmp/x", origin="recovered_from_history")
    assert l.is_tracked("/tmp/x")
    assert "BLOCK" in l.is_safe_to_delete("/tmp/x")
    l.untrack("/tmp/x")
    assert not l.is_tracked("/tmp/x")


def test_asset_decision_is_pure_query():
    """Regression: is_safe_to_delete used to mutate status and rewrite the
    whole file on every guard check, amplifying concurrent-write races."""
    tmp = Path(tempfile.mkdtemp())
    store = tmp / "assets.json"
    l = AssetLedger(str(store))
    l.track("/tmp/y", origin="recovered_from_history")
    before = store.stat().st_mtime_ns
    time.sleep(0.01)
    assert "BLOCK" in l.is_safe_to_delete("/tmp/y")
    assert "BLOCK" in l.is_safe_to_delete("/tmp/y")
    assert store.stat().st_mtime_ns == before


def test_load_tolerates_unknown_fields():
    """Forward compat: a ledger written by a newer version must not crash
    the reader (crash would silently untrack every asset)."""
    tmp = Path(tempfile.mkdtemp())
    store = tmp / "assets.json"
    store.write_text(json.dumps({
        "/tmp/z": {"path": "/tmp/z", "origin": "user_created", "future_field": 42}
    }))
    l = AssetLedger(str(store))
    assert l.is_tracked("/tmp/z")
    entry = l.get("/tmp/z")
    assert entry.origin == "user_created"
    assert not hasattr(entry, "future_field")


def test_backcompat_internal_alias():
    tmp = Path(tempfile.mkdtemp())
    l = AssetLedger(str(tmp / "assets.json"))
    l.track("/tmp/alias", origin="agent_generated")
    assert len(l._assets) == 1  # older code / tests read ledger._assets


# ── CapabilityLedger state machine ──────────────────────────────────────────

def test_capability_advances_in_order():
    tmp = Path(tempfile.mkdtemp())
    l = CapabilityLedger(str(tmp / "caps.json"))
    l.track(".env", "OPENAI_API_KEY", dependents=["src/api.py"])
    assert "BLOCK" in l.removal_decision(".env")
    l.mark_replacement_configured(".env", "env:OPENAI_API_KEY")
    assert "BLOCK" in l.removal_decision(".env")
    l.mark_replacement_verified(".env")
    assert "CONFIRM" in l.removal_decision(".env")
    l.mark_workflow_passed(".env", "pytest tests/test_api.py")
    l.mark_removable(".env")
    assert l.removal_decision(".env") == "ALLOW: replacement_verified_workflow_passed"


def test_capability_rejects_jump():
    """Regression: track() then mark_removable() used to succeed — an
    unverified credential became deletable with no verification chain."""
    tmp = Path(tempfile.mkdtemp())
    l = CapabilityLedger(str(tmp / "caps.json"))
    l.track(".env", "OPENAI_API_KEY")
    try:
        l.mark_removable(".env")
        raise AssertionError("state jump must raise ValueError")
    except ValueError as e:
        assert "state jump" in str(e)
    # state unchanged — still BLOCK
    assert "BLOCK" in l.removal_decision(".env")


def test_capability_rejects_mid_chain_jump():
    tmp = Path(tempfile.mkdtemp())
    l = CapabilityLedger(str(tmp / "caps.json"))
    l.track(".env", "OPENAI_API_KEY")
    l.mark_replacement_configured(".env", "env:OPENAI_API_KEY")
    try:
        l.mark_removable(".env")  # skips verified + workflow-passed
        raise AssertionError("mid-chain jump must raise ValueError")
    except ValueError:
        pass


def test_capability_idempotent_recall():
    tmp = Path(tempfile.mkdtemp())
    l = CapabilityLedger(str(tmp / "caps.json"))
    l.track(".env", "OPENAI_API_KEY")
    l.mark_replacement_configured(".env", "env:OPENAI_API_KEY")
    # Re-calling the same transition (e.g. re-pointing the source) is fine
    l.mark_replacement_configured(".env", "env:NEW_KEY")
    assert l.get(".env").replacement_source == "env:NEW_KEY"
    assert "BLOCK" in l.removal_decision(".env")


def test_capability_unknown_path_raises():
    tmp = Path(tempfile.mkdtemp())
    l = CapabilityLedger(str(tmp / "caps.json"))
    try:
        l.mark_removable("/nope")
        raise AssertionError("untracked path must raise KeyError")
    except KeyError:
        pass


def test_capability_backcompat_internal_alias():
    tmp = Path(tempfile.mkdtemp())
    l = CapabilityLedger(str(tmp / "caps.json"))
    l.track(".env", "OPENAI_API_KEY")
    assert len(l._caps) == 1  # older code reads ledger._caps


# ── Cross-process safety (KeyedJsonLedger._save merge) ──────────────────────

def _worker(path, prefix):
    for i in range(5):
        l = AssetLedger(path)
        l.track(f"/tmp/concurrent-{prefix}-{i}", origin="agent_generated")


def test_concurrent_writers_lose_no_entries():
    """Regression: shared .tmp filename + read-modify-write with no lock lost
    entries (one process's rename clobbered the other's .tmp)."""
    tmp = Path(tempfile.mkdtemp())
    store = str(tmp / "assets.json")
    procs = [
        multiprocessing.Process(target=_worker, args=(store, "a")),
        multiprocessing.Process(target=_worker, args=(store, "b")),
    ]
    for p in procs:
        p.start()
    for p in procs:
        p.join()
    assert all(p.exitcode == 0 for p in procs)

    l = AssetLedger(store)
    for prefix in ("a", "b"):
        for i in range(5):
            assert l.is_tracked(f"/tmp/concurrent-{prefix}-{i}"), f"lost {prefix}-{i}"

    # No leftover tmp files
    leftovers = [f for f in os.listdir(tmp) if f.endswith(".tmp")]
    assert leftovers == []


def test_ledger_base_requires_entry_type():
    """The base class requires a concrete _entry_type (fail loud, not silent)."""
    tmp = Path(tempfile.mkdtemp())
    store = tmp / "bare.json"
    store.write_text(json.dumps({"/tmp/x": {}}))
    try:
        KeyedJsonLedger(str(store))
        raise AssertionError("bare ledger with no _entry_type must fail on load")
    except TypeError:
        pass
