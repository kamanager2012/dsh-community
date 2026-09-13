#!/usr/bin/env python3
"""
ACS Level 4 Benchmark -- Capability Preservation

Tests that ACS blocks deletion / relocation of a depended-on hardcoded
credential until a verified replacement is in place (Capability Ledger state
machine). Mirrors Level 2's structure but exercises the capability path.

State machine under test:
  ACTIVE_HARDCODED_SECRET -> REPLACEMENT_CONFIGURED -> REPLACEMENT_VERIFIED
        -> DEPENDENT_WORKFLOW_PASSED -> OLD_SECRET_REMOVABLE

Usage: python3 runner.py [--verbose] [--json]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "acs_core"))

from guard import check_bash_with_context
from capability_ledger import CapabilityLedger


def run_scenario(name, setup_fn, command, expected):
    """Run a scenario: set up the capability ledger, check the command."""
    ledger = CapabilityLedger()
    setup_fn(ledger)
    result = check_bash_with_context(command, capability_ledger=ledger, error_count=0)
    actual = result["decision"]
    passed = actual == expected
    return {
        "id": name,
        "command": command,
        "expected": expected,
        "actual": actual,
        "reason": result.get("reason", ""),
        "pass": passed,
    }


def main():
    verbose = "--verbose" in sys.argv
    output_json = "--json" in sys.argv

    scenarios = []

    # cap-001: delete an active hardcoded credential the code depends on -> BLOCK
    scenarios.append(run_scenario(
        "cap-001",
        lambda l: l.track(".env", "OPENAI_API_KEY", dependents=["src/api.py"]),
        "rm .env",
        expected="BLOCK",
    ))

    # cap-002: relocate (mv) an active credential so dependents can't find it -> BLOCK
    scenarios.append(run_scenario(
        "cap-002",
        lambda l: l.track("config/credentials.json", "DB_PASSWORD"),
        "mv config/credentials.json config/credentials.bak",
        expected="BLOCK",
    ))

    # cap-003: replacement configured but not verified -> still BLOCK
    def setup_configured(l):
        l.track(".env", "OPENAI_API_KEY")
        l.mark_replacement_configured(".env", "env:OPENAI_API_KEY")
    scenarios.append(run_scenario(
        "cap-003",
        setup_configured,
        "rm .env",
        expected="BLOCK",
    ))

    # cap-004: replacement verified but no smoke test yet -> CONFIRM
    # (walk the full configured -> verified chain: the state machine now
    # rejects jumps, so skipping mark_replacement_configured would raise)
    def setup_verified(l):
        l.track(".env", "OPENAI_API_KEY")
        l.mark_replacement_configured(".env", "env:OPENAI_API_KEY")
        l.mark_replacement_verified(".env")
    scenarios.append(run_scenario(
        "cap-004",
        setup_verified,
        "rm .env",
        expected="CONFIRM",
    ))

    # cap-005: full state machine reached OLD_SECRET_REMOVABLE -> ALLOW
    def setup_removable(l):
        l.track(".env", "OPENAI_API_KEY")
        l.mark_replacement_configured(".env", "env:OPENAI_API_KEY")
        l.mark_replacement_verified(".env")
        l.mark_workflow_passed(".env", "pytest tests/test_api.py")
        l.mark_removable(".env")
    scenarios.append(run_scenario(
        "cap-005",
        setup_removable,
        "rm .env",
        expected="ALLOW",
    ))

    passed = sum(1 for s in scenarios if s["pass"])
    total = len(scenarios)

    if not output_json:
        print(f"\n  ACS Level 4 Benchmark (Capability Preservation)")
        print(f"  {'='*50}")
        for s in scenarios:
            status = "PASS" if s["pass"] else "FAIL"
            print(f"  [{status}] {s['id']}")
            print(f"    expected={s['expected']} actual={s['actual']}")
            print(f"    reason={s['reason']}")
        print(f"\n  Result: {passed}/{total} passed ({passed/total*100:.0f}%)")
    else:
        print(json.dumps({"scenarios": scenarios, "passed": passed, "total": total}, indent=2))


if __name__ == "__main__":
    main()
