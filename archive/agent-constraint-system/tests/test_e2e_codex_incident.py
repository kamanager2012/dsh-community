#!/usr/bin/env python3
"""
ACS End-to-End Test: Real Codex Incident with Auto-Tracking

Simulates the full agent session from the real incident:
  1. Agent writes recovered data to project dir
  2. AssetTracker auto-marks origin=agent_write
  3. Agent moves data to /tmp
  4. AssetTracker auto-records the move
  5. Agent attempts rm -rf
  6. ACS BLOCKS based on auto-tracked state (no manual ledger.track!)

Also tests SafeMode persistence across process restarts.

Usage: python3 tests/test_e2e_codex_incident.py
"""
import json, os, sys, tempfile, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "acs_core"))

from guard import check_bash_with_context
from asset_ledger import AssetLedger, AssetTracker
from safe_mode import SafeMode


class E2ERunner:
    """Simulates a Codex agent session with ACS hooks."""

    def __init__(self, tmpdir):
        self.tmpdir = Path(tmpdir)
        self.runtime_dir = self.tmpdir / "runtime"
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.ledger = AssetLedger(str(self.runtime_dir / "asset_ledger.json"))
        self.tracker = AssetTracker(self.ledger)
        self.safe_mode = SafeMode(str(self.runtime_dir / "safe_mode.json"))
        self.results = []

    def simulate_write(self, filepath, origin_hint="agent_write"):
        """Simulate agent writing a file (e.g., recovering from history)."""
        Path(filepath).parent.mkdir(parents=True, exist_ok=True)
        Path(filepath).write_text("recovered content")
        # Auto-track: agent wrote this file, mark origin
        self.tracker.on_write(filepath, origin_hint=origin_hint)

    def simulate_move(self, source, dest):
        """Simulate agent moving a file."""
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        Path(source).rename(dest)
        # Auto-track: record the move
        self.tracker.on_move(source, dest)

    def simulate_bash(self, command, expected_decision):
        """Simulate agent running a bash command through the ACS check."""
        result = check_bash_with_context(command, asset_ledger=self.ledger, error_count=self.safe_mode.error_count())
        actual = result["decision"]
        passed = actual == expected_decision
        self.results.append({
            "step": command[:60],
            "expected": expected_decision,
            "actual": actual,
            "reason": result["reason"],
            "pass": passed,
        })
        # If agent made mistake, record it
        if not passed and expected_decision != "ALLOW":
            self.safe_mode.record_error(f"unexpected result: {actual} vs {expected_decision}")
        return passed

    def simulate_error(self, description):
        self.safe_mode.record_error(description)

    def status(self):
        return {
            "ledger_entries": len(self.ledger._assets),
            "safe_mode_active": self.safe_mode.is_active(),
            "safe_mode_errors": self.safe_mode.error_count(),
            "results": self.results,
        }


def test_full_incident():
    """Full real incident: auto-tracked AssetLedger should BLOCK the rm."""
    print("\n=== Test 1: Full Real Incident (Auto-Tracked) ===\n")

    with tempfile.TemporaryDirectory() as tmp:
        runner = E2ERunner(tmp)
        proj = Path(tmp) / "project"
        tmpdir = Path(tmp) / "tmpdir"

        # Step 1: Agent writes recovered data (Auto-track the directory, not just file)
        dramatics_dir = str(proj / "dramatools")
        Path(dramatics_dir).mkdir(parents=True, exist_ok=True)
        Path(dramatics_dir + "/important.py").write_text("recovered")
        runner.tracker.on_write(dramatics_dir, origin_hint="recovered_from_history")
        print("  [1] Agent wrote recovered data -> AssetTracker auto-tracked directory")

        # Step 2: Agent moves to /tmp (misdirected)
        runner.simulate_move(
            str(proj / "dramatools"),
            str(tmpdir / "dramatools-mistaken-copy-20260723")
        )
        print("  [2] Agent moved recovered data -> AssetTracker auto-recorded move")

        # Step 3: Agent makes two errors (misunderstands user)
        runner.simulate_error("agent misidentified file location")
        runner.simulate_error("agent misinterpreted user question")

        # Step 4: Agent attempts rm -rf
        result = runner.simulate_bash(
            f"rm -rf {tmpdir}/dramatools-mistaken-copy-20260723",
            expected_decision="BLOCK"
        )
        status = runner.status()
        print(f"  [3] Agent attempted rm -rf -> {runner.results[-1]['actual']}")
        print(f"      reason: {runner.results[-1]['reason']}")
        print(f"      ledger entries: {status['ledger_entries']}")
        print(f"      safe_mode: active={status['safe_mode_active']} errors={status['safe_mode_errors']}")

    passed = all(r["pass"] for r in runner.results)
    print(f"\n  Result: {'PASS' if passed else 'FAIL'}")
    assert passed, f"E2E incident scenario failed: {[r for r in runner.results if not r['pass']]}"
    return passed  # main() relies on this; pytest only warns about the bool


def test_safemode_persistence():
    """Test that SafeMode errors survive process restarts."""
    print("\n=== Test 2: SafeMode Cross-Process Persistence ===\n")

    with tempfile.TemporaryDirectory() as tmp:
        sm_path = str(Path(tmp) / "safe_mode.json")

        # Process 1: Record two errors
        sm1 = SafeMode(sm_path)
        sm1.record_error("error in process 1")
        sm1.record_error("error in process 1")
        print(f"  [Process 1] errors={sm1.error_count()} active={sm1.is_active()}")
        assert sm1.is_active(), "SafeMode should be active after 2 errors"

        # Process 2: Should see the same errors (simulated restart)
        sm2 = SafeMode(sm_path)
        print(f"  [Process 2] errors={sm2.error_count()} active={sm2.is_active()}")
        assert sm2.is_active(), "SafeMode should persist across processes"
        assert sm2.error_count() == 2, "Should have 2 errors from process 1"

        # Process 3: Reset
        sm2.reset()
        sm3 = SafeMode(sm_path)
        print(f"  [Process 3] errors={sm3.error_count()} active={sm3.is_active()}")
        assert not sm3.is_active(), "SafeMode should be inactive after reset"

    print("\n  Result: PASS")
    return True


def main():
    all_pass = True
    all_pass &= test_full_incident()
    all_pass &= test_safemode_persistence()

    sys.exit(0 if all_pass else 1)


if __name__ == "__main__":
    main()
