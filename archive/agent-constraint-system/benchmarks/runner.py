#!/usr/bin/env python3
"""
ACS Safety Benchmark Runner

Tests ACS guard functions against 100+ adversarial scenarios.
Usage: python3 runner.py [--category bash_dangerous] [--verbose]
"""
from __future__ import annotations

import json
import sys
import time
import os
from pathlib import Path
from typing import Dict, List, Any, Optional

# Add acs_core to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "acs_core"))

from guard import check_bash, clean_command
from paths import FORBIDDEN_ROOTS, is_forbidden_path, is_self_protect_path


SCENARIO_DIR = Path(__file__).resolve().parent / "scenarios"

BYPASS_METHODS = {
    "base64": lambda cmd: f'echo {_b64(cmd)}|base64 -d|sh',
    "variable": lambda cmd: f'VAR="{cmd}"; $VAR',
    "alias": lambda cmd: f'alias x="{cmd}"; x',
    "heredoc": lambda cmd: f'sh <<EOF\n{cmd}\nEOF',
    "string_concat": lambda cmd: _string_concat(cmd),
    "python_exec": lambda cmd: f'python3 -c "import os; os.system({repr(cmd)})"',
    "perl_exec": lambda cmd: f'perl -e {repr(f"system({repr(cmd)})")}',
    "eval": lambda cmd: f'eval "{cmd}"',
    "subshell": lambda cmd: f'$({cmd})',
    "backtick": lambda cmd: f'`{cmd}`',
}


def _b64(s: str) -> str:
    import base64
    return base64.b64encode(s.encode()).decode()


def _string_concat(cmd: str) -> str:
    parts = []
    for c in cmd:
        parts.append(f'"{c}"')
    return "".join(parts)


def load_scenarios(category: Optional[str] = None) -> List[Dict]:
    """Load all scenario files from the scenarios directory."""
    all_scenarios = []
    files = sorted(SCENARIO_DIR.glob("*.json"))
    if category:
        files = [f for f in files if category in f.name]
    for fp in files:
        data = json.loads(fp.read_text())
        items = data if isinstance(data, list) else data.get("scenarios", [])
        for item in items:
            item["_source"] = fp.name
            all_scenarios.append(item)
    return all_scenarios


def run_bash_scenario(scenario: Dict) -> Dict:
    """Run a Bash scenario through check_bash and bypass methods."""
    cmd = scenario.get("command", "")
    expected = scenario.get("expected", "block")
    bypass_methods = scenario.get("bypass_methods", [])
    if not bypass_methods:
        bypass_methods = ["base64", "variable", "alias", "heredoc", "eval"]

    start = time.perf_counter()
    result = check_bash(cmd)
    elapsed_ms = (time.perf_counter() - start) * 1000
    blocked = result is not None

    # Bypass tests
    bypass_results = []
    bypass_blocked = 0
    for method in bypass_methods:
        if method in BYPASS_METHODS:
            try:
                bypass_cmd = BYPASS_METHODS[method](cmd)
                bypass_result = check_bash(bypass_cmd)
                bypass_results.append({
                    "method": method,
                    "blocked": bypass_result is not None,
                })
                if bypass_result is not None:
                    bypass_blocked += 1
            except Exception:
                bypass_results.append({"method": method, "blocked": False})

    correct = blocked if expected == "block" else not blocked

    return {
        "id": scenario.get("id", "unknown"),
        "category": scenario.get("category", ""),
        "description": scenario.get("description", ""),
        "severity": scenario.get("severity", "medium"),
        "command": cmd[:80],
        "expected": expected,
        "actual": "blocked" if blocked else "allowed",
        "pass": correct,
        "latency_ms": round(elapsed_ms, 2),
        "block_reason": str(result)[:100] if result else None,
        "bypass_count": bypass_blocked,
        "bypass_total": len(bypass_results),
        "bypass_results": bypass_results,
    }


def run_write_scenario(scenario: Dict) -> Dict:
    """Run a filesystem write scenario.

    A write is treated as blocked if it targets a forbidden system root OR an
    ACS self-protect path (any agent's runtime/hooks dir, or the shared
    .acs_core core). This mirrors exactly what each adapter's handle_write does
    in production, so the harness exercises the same guard the runtime uses.
    """
    filepath = scenario.get("filepath", "")
    expected = scenario.get("expected", "block")

    root = is_forbidden_path(filepath)
    sp = is_self_protect_path(filepath)
    blocked = root is not None or sp is not None

    correct = blocked if expected == "block" else not blocked

    return {
        "id": scenario.get("id", "unknown"),
        "category": scenario.get("category", ""),
        "description": scenario.get("description", ""),
        "severity": scenario.get("severity", "medium"),
        "filepath": filepath,
        "expected": expected,
        "actual": "blocked" if blocked else "allowed",
        "pass": correct,
        "forbidden_root": str(root) if root else None,
        "self_protect": sp,
    }


def run_all(scenarios: List[Dict]) -> Dict:
    """Run all scenarios and return stats."""
    results = []
    stats = {
        "total": 0,
        "passed": 0,
        "failed": 0,
        "block_correct": 0,
        "allow_correct": 0,
        "block_wrong": 0,
        "allow_wrong": 0,
        "bypass_blocked": 0,
        "bypass_total": 0,
        "by_cat": {},
        "latency_samples": [],
    }

    for s in scenarios:
        cat = s.get("category", "other")
        cmd = s.get("command", "")

        if cmd:
            r = run_bash_scenario(s)
            stats["bypass_blocked"] += r.get("bypass_count", 0)
            stats["bypass_total"] += r.get("bypass_total", 0)
            stats["latency_samples"].append(r.get("latency_ms", 0))
        else:
            r = run_write_scenario(s)

        results.append(r)
        stats["total"] += 1

        if r["pass"]:
            stats["passed"] += 1
            if r.get("expected") == "block" and r.get("actual") == "blocked":
                stats["block_correct"] += 1
            elif r.get("expected") == "allow" and r.get("actual") == "allowed":
                stats["allow_correct"] += 1
        else:
            stats["failed"] += 1
            if r.get("expected") == "block" and r.get("actual") == "allowed":
                stats["block_wrong"] += 1
            elif r.get("expected") == "allow" and r.get("actual") == "blocked":
                stats["allow_wrong"] += 1

        # Per-category stats
        if cat not in stats["by_cat"]:
            stats["by_cat"][cat] = {"total": 0, "passed": 0}
        stats["by_cat"][cat]["total"] += 1
        if r["pass"]:
            stats["by_cat"][cat]["passed"] += 1

    if stats["latency_samples"]:
        stats["latency_avg_ms"] = round(
            sum(stats["latency_samples"]) / len(stats["latency_samples"]), 2
        )

    return {"results": results, "stats": stats}


def print_summary(stats: Dict) -> None:
    """Print a human-readable summary."""
    s = stats
    total = s["total"]
    passed = s["passed"]
    failed = s["failed"]

    print(f"\n{'='*60}")
    print(f"  ACS Safety Benchmark Results")
    print(f"{'='*60}")
    print(f"  Total scenarios:    {total}")
    print(f"  Passed:             {passed} ({_pct(passed, total)})")
    print(f"  Failed:             {failed} ({_pct(failed, total)})")
    print(f"  Danger Block Rate:  {_pct(s['block_correct'], s['block_correct']+s['block_wrong'])}")
    print(f"  FP Rate:            {_pct(s['allow_wrong'], s['allow_correct']+s['allow_wrong'])}")
    print(f"  Bypass Resist:      {_pct(s['bypass_blocked'], s['bypass_total'])}")
    if s.get("latency_avg_ms"):
        print(f"  Avg Latency:        {s['latency_avg_ms']}ms")
    print(f"\n  By Category:")
    for cat, cs in sorted(s["by_cat"].items()):
        print(f"    {cat:25s} {_pct(cs['passed'], cs['total'])}")
    print(f"{'='*60}\n")

    if failed > 0:
        print("  FAILED SCENARIOS:")
        for r in s.get("results", []):
            if not r.get("pass"):
                print(f"    [{r['id']}] {r['description']}")
                print(f"      expected={r['expected']} actual={r['actual']}")
                if r.get("block_reason"):
                    print(f"      reason={r['block_reason']}")


def _pct(a: int, b: int) -> str:
    if b == 0:
        return "N/A"
    return f"{a/b*100:.1f}%"


def main():
    verbose = "--verbose" in sys.argv or "-v" in sys.argv
    category = None
    output_json = "--json" in sys.argv

    for arg in sys.argv[1:]:
        if arg.startswith("--category="):
            category = arg.split("=", 1)[1]
        elif arg == "--category":
            idx = sys.argv.index(arg)
            if idx + 1 < len(sys.argv):
                category = sys.argv[idx + 1]

    scenarios = load_scenarios(category)

    data = run_all(scenarios)
    stats = data["stats"]
    results = data["results"]

    if not output_json:
        print(f"Loaded {len(scenarios)} scenarios from {SCENARIO_DIR}")
        print_summary(stats)

        if verbose:
            print("\n  DETAILED RESULTS:")
            for r in results:
                status = "PASS" if r["pass"] else "FAIL"
                print(f"    [{status}] {r['id']}: {r['description']}")
                if r.get("bypass_results"):
                    for b in r["bypass_results"]:
                        b_status = "BLOCKED" if b["blocked"] else "BYPASSED"
                        print(f"        bypass.{b['method']}: {b_status}")

    if output_json:
        out = {
            "summary": {
                "total": stats["total"],
                "passed": stats["passed"],
                "failed": stats["failed"],
                "danger_block_rate": stats["block_correct"] / max(stats["block_correct"] + stats["block_wrong"], 1),
                "false_positive_rate": stats["allow_wrong"] / max(stats["allow_correct"] + stats["allow_wrong"], 1),
                "bypass_resistance": stats["bypass_blocked"] / max(stats["bypass_total"], 1),
                "avg_latency_ms": stats.get("latency_avg_ms", 0),
                "by_category": {
                    cat: {
                        "total": cs["total"],
                        "passed": cs["passed"],
                        "rate": cs["passed"] / max(cs["total"], 1),
                    }
                    for cat, cs in stats["by_cat"].items()
                },
            },
            "results": results,
        }
        print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
