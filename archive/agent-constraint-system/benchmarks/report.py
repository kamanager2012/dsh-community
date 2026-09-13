#!/usr/bin/env python3
"""
ACS Benchmark Report Generator

Reads benchmark results and generates formatted reports.
Usage: python3 report.py [results.json] [--markdown] [--json]
"""
import json
import sys
from pathlib import Path
from datetime import datetime


def load_results(path: str = None) -> dict:
    """Load benchmark results from JSON file."""
    if not path:
        path = Path(__file__).parent / "results.json"
    with open(path) as f:
        return json.load(f)


def generate_markdown(data: dict) -> str:
    """Generate a Markdown report from benchmark data."""
    s = data["summary"]
    r = data["results"]

    total = s["total"]
    passed = s["passed"]
    failed = s["failed"]
    danger_rate = s["danger_block_rate"] * 100
    bypass_rate = s["bypass_resistance"] * 100
    fp_rate = s.get("false_positive_rate", 0) * 100
    avg_lat = s.get("avg_latency_ms", 0)

    md = f"""# ACS Safety Benchmark Report

> Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}

## Summary

| Metric | Value |
|--------|-------|
| Total Scenarios | {total} |
| Passed | {passed} |
| Failed | {failed} |
| **Danger Block Rate** | **{danger_rate:.1f}%** |
| **Bypass Resistance** | **{bypass_rate:.1f}%** |
| False Positive Rate | **{fp_rate:.1f}%** |
| Avg Latency | {avg_lat:.2f}ms |

## Results by Category

| Category | Total | Passed | Rate |
|----------|-------|--------|------|
"""

    for cat, cs in sorted(s["by_category"].items()):
        rate = cs["rate"] * 100
        md += f"| {cat} | {cs['total']} | {cs['passed']} | {rate:.1f}% |\n"

    # Failed scenarios detail
    failed_items = [x for x in r if not x.get("pass")]
    if failed_items:
        md += "\n## Failed Scenarios\n\n"
        md += "| ID | Category | Description | Expected | Actual |\n"
        md += "|----|----------|-------------|----------|--------|\n"
        for item in failed_items:
            md += f"| {item['id']} | {item.get('category', '')} | {item.get('description', '')[:60]} | {item.get('expected', '')} | {item.get('actual', '')} |\n"

    # Bypass summary
    all_bypasses = []
    for item in r:
        for b in item.get("bypass_results", []):
            if not b.get("blocked"):
                all_bypasses.append({
                    "id": item["id"],
                    "desc": item.get("description", ""),
                    "method": b["method"],
                })

    if all_bypasses:
        md += f"\n## Bypass Vectors ({len(all_bypasses)} found)\n\n"
        md += "| Scenario ID | Description | Bypass Method |\n"
        md += "|-------------|-------------|---------------|\n"
        for b in all_bypasses[:20]:
            md += f"| {b['id']} | {b['desc'][:50]} | {b['method']} |\n"
        if len(all_bypasses) > 20:
            md += f"| ... | ({len(all_bypasses) - 20} more) | ... |\n"

    return md


def generate_json(data: dict) -> str:
    return json.dumps(data, indent=2)


def main():
    args = sys.argv[1:]
    input_file = None
    output_format = "markdown"

    for arg in args:
        if arg == "--markdown":
            output_format = "markdown"
        elif arg == "--json":
            output_format = "json"
        elif arg.endswith(".json"):
            input_file = arg

    data = load_results(input_file)

    if output_format == "json":
        print(generate_json(data))
    else:
        print(generate_markdown(data))


if __name__ == "__main__":
    main()
