#!/usr/bin/env python3
"""Run bilingual retrieval regression tests against the static catalogs."""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from query_ai_catalog import score, terms  # noqa: E402


def load_catalog(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle]


def metric(cases: list[dict[str, Any]], key: str) -> float:
    if not cases:
        return 0.0
    return sum(1 for case in cases if case[key]) / len(cases)


def evaluate(root: Path, cases_path: Path, zh_catalog: Path, en_catalog: Path, limit: int) -> dict[str, Any]:
    fixture = json.loads(cases_path.read_text(encoding="utf-8"))
    cases = fixture.get("cases", [])
    catalogs = {
        "zh-CN": load_catalog(zh_catalog),
        "en": load_catalog(en_catalog),
    }
    by_id = {language: {record["id"] for record in records} for language, records in catalogs.items()}
    results: list[dict[str, Any]] = []
    errors: list[str] = []

    for case in cases:
        language = case.get("language")
        records = catalogs.get(language, [])
        expected_ids = set(case.get("expected_record_ids", []))
        expected_paths = set(case.get("expected_source_paths", []))
        missing_ids = expected_ids - by_id.get(language, set())
        if missing_ids:
            errors.append(f"{case.get('id')}: missing expected IDs {sorted(missing_ids)}")

        query_terms = terms(case.get("query", ""))
        ranked = sorted(
            (
                (score(record, query_terms), record)
                for record in records
                if score(record, query_terms) > 0
            ),
            key=lambda item: (-item[0], item[1]["id"]),
        )
        top = ranked[: max(limit, 5)]
        relevant_rank = next(
            (index for index, (_value, record) in enumerate(top, start=1) if record["id"] in expected_ids),
            None,
        )
        source_rank = next(
            (
                index
                for index, (_value, record) in enumerate(top, start=1)
                if record.get("source", {}).get("path") in expected_paths
            ),
            None,
        )
        top_record = top[0][1] if top else None
        context = "\n".join(
            " ".join(
                [
                    record.get("title", ""),
                    record.get("section_title", ""),
                    record.get("summary", ""),
                    record.get("content", ""),
                ]
            )
            for _value, record in top[:5]
        ).lower()
        required_terms = case.get("must_include_terms", [])
        term_hits = [value for value in required_terms if value.lower() in context]
        result = {
            "id": case.get("id"),
            "language": language,
            "category": case.get("category", "uncategorized"),
            "query": case.get("query"),
            "rank": relevant_rank,
            "hit_at_1": relevant_rank == 1,
            "hit_at_3": relevant_rank is not None and relevant_rank <= 3,
            "hit_at_5": relevant_rank is not None and relevant_rank <= 5,
            "mrr": 1 / relevant_rank if relevant_rank else 0.0,
            "source_rank": source_rank,
            "source_hit_at_1": source_rank == 1,
            "source_hit_at_3": source_rank is not None and source_rank <= 3,
            "source_hit_at_5": source_rank is not None and source_rank <= 5,
            "source_mrr": 1 / source_rank if source_rank else 0.0,
            "source_accuracy_at_1": source_rank == 1,
            "term_hits": term_hits,
            "term_total": len(required_terms),
            "top": [
                {
                    "score": value,
                    "id": record["id"],
                    "title": record["title"],
                    "section_title": record["section_title"],
                    "source": record["source"],
                }
                for value, record in top[:5]
            ],
        }
        results.append(result)

    categories: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for result in results:
        categories[result["category"]].append(result)

    total_terms = sum(result["term_total"] for result in results)
    hit_terms = sum(len(result["term_hits"]) for result in results)
    summary = {
        "cases": len(results),
        "languages": {
            language: sum(1 for result in results if result["language"] == language)
            for language in catalogs
        },
        "recall_at_1": metric(results, "hit_at_1"),
        "recall_at_3": metric(results, "hit_at_3"),
        "recall_at_5": metric(results, "hit_at_5"),
        "mrr": sum(result["mrr"] for result in results) / len(results) if results else 0.0,
        "source_recall_at_1": metric(results, "source_hit_at_1"),
        "source_recall_at_3": metric(results, "source_hit_at_3"),
        "source_recall_at_5": metric(results, "source_hit_at_5"),
        "source_mrr": sum(result["source_mrr"] for result in results) / len(results) if results else 0.0,
        "source_accuracy_at_1": metric(results, "source_accuracy_at_1"),
        "required_term_coverage": hit_terms / total_terms if total_terms else 1.0,
    }
    by_category = {
        category: {
            "cases": len(category_cases),
            "recall_at_1": metric(category_cases, "hit_at_1"),
            "recall_at_3": metric(category_cases, "hit_at_3"),
            "recall_at_5": metric(category_cases, "hit_at_5"),
            "mrr": sum(case["mrr"] for case in category_cases) / len(category_cases),
            "source_recall_at_5": metric(category_cases, "source_hit_at_5"),
        }
        for category, category_cases in sorted(categories.items())
    }
    record_failures = [result for result in results if not result["hit_at_5"]]
    source_top1_misses = [result for result in results if not result["source_accuracy_at_1"]]
    source_top5_misses = [result for result in results if not result["source_hit_at_5"]]
    return {
        "schema_version": "1.0",
        "fixture": str(cases_path.relative_to(root)),
        "scorer": "query_ai_catalog.score: deterministic weighted substring baseline",
        "summary": summary,
        "by_category": by_category,
        "record_failures": record_failures,
        "source_top1_misses": source_top1_misses,
        "source_top5_misses": source_top5_misses,
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--cases", type=Path, default=ROOT / "eval/retrieval_cases.json")
    parser.add_argument("--catalog", type=Path, default=ROOT / "ai/catalog.jsonl")
    parser.add_argument("--catalog-en", type=Path, default=ROOT / "ai/catalog.en.jsonl")
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--json", action="store_true", help="print the full JSON report")
    parser.add_argument("--min-recall-at-5", type=float)
    parser.add_argument("--min-mrr", type=float)
    parser.add_argument("--min-source-accuracy-at-1", type=float)
    parser.add_argument("--min-term-coverage", type=float)
    args = parser.parse_args()
    root = args.root.resolve()
    report = evaluate(root, args.cases.resolve(), args.catalog.resolve(), args.catalog_en.resolve(), args.limit)
    summary = report["summary"]
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"Retrieval evaluation: {summary['cases']} cases ({summary['languages']})")
        for name in (
            "recall_at_1",
            "recall_at_3",
            "recall_at_5",
            "mrr",
            "source_recall_at_1",
            "source_recall_at_3",
            "source_recall_at_5",
            "source_mrr",
            "required_term_coverage",
        ):
            print(f"- {name}: {summary[name]:.3f}")
        if report["record_failures"]:
            print(f"- exact-record misses outside top 5: {len(report['record_failures'])}")
            for failure in report["record_failures"][:10]:
                print(f"  - {failure['id']}: rank={failure['rank']}")
        if report["source_top1_misses"]:
            print(f"- source top-1 misses: {len(report['source_top1_misses'])}")
            for failure in report["source_top1_misses"][:10]:
                print(f"  - {failure['id']}: source_rank={failure['source_rank']}")
        if report["source_top5_misses"]:
            print(f"- source misses outside top 5: {len(report['source_top5_misses'])}")
            for failure in report["source_top5_misses"][:10]:
                print(f"  - {failure['id']}: source_rank={failure['source_rank']}")
        if report["errors"]:
            print("- fixture errors:")
            for error in report["errors"]:
                print(f"  - {error}")

    if report["errors"]:
        return 1
    if args.min_recall_at_5 is not None and summary["recall_at_5"] < args.min_recall_at_5:
        return 1
    if args.min_mrr is not None and summary["mrr"] < args.min_mrr:
        return 1
    if args.min_source_accuracy_at_1 is not None and summary["source_accuracy_at_1"] < args.min_source_accuracy_at_1:
        return 1
    if args.min_term_coverage is not None and summary["required_term_coverage"] < args.min_term_coverage:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
