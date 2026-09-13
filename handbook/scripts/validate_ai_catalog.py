#!/usr/bin/env python3
"""Validate the bilingual AI retrieval package and its source ranges."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_jsonl(path: Path, errors: list[str]) -> list[tuple[int, dict]]:
    records: list[tuple[int, dict]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            try:
                records.append((line_number, json.loads(line)))
            except json.JSONDecodeError as exc:
                errors.append(f"{path.name}:{line_number}: invalid JSON: {exc}")
    return records


def validate_terms(
    terms: list[dict],
    expected_language: str,
    expected_path: str,
    errors: list[str],
    label: str,
) -> None:
    names: set[tuple[str, str]] = set()
    for index, item in enumerate(terms, start=1):
        if not item.get("term") or not item.get("definition") or not item.get("source"):
            errors.append(f"{label}:{index}: missing term, definition, or source")
        key = (item.get("language", ""), item.get("term", ""))
        if key in names:
            errors.append(f"{label}:{index}: duplicate term {key[1]}")
        names.add(key)
        if item.get("language") != expected_language:
            errors.append(f"{label}:{index}: expected language {expected_language}")
        source = item.get("source", {})
        if source.get("path") != expected_path:
            errors.append(f"{label}:{index}: unexpected source path {source.get('path')}")


def validate_records(
    root: Path,
    records: list[tuple[int, dict]],
    document_ids: set[str],
    expected_language: str,
    allowed_prefix: str,
    label: str,
    errors: list[str],
) -> None:
    ids: set[str] = set()
    required = (
        "schema_version",
        "id",
        "document_id",
        "title",
        "section_title",
        "kind",
        "language",
        "content",
        "source",
    )
    for line_number, record in records:
        for field in required:
            if field not in record:
                errors.append(f"{label}:{line_number}: missing {field}")
        record_id = record.get("id")
        if record_id in ids:
            errors.append(f"{label}:{line_number}: duplicate id {record_id}")
        ids.add(record_id)
        if record.get("language") != expected_language:
            errors.append(f"{label}:{line_number}: expected language {expected_language}")
        if record.get("document_id") not in document_ids:
            errors.append(f"{label}:{line_number}: unknown document_id {record.get('document_id')}")

        source = record.get("source", {})
        relative_path = source.get("path")
        if not isinstance(relative_path, str) or not relative_path.startswith(allowed_prefix):
            errors.append(f"{label}:{line_number}: source must be under {allowed_prefix}")
            continue
        source_path = root / relative_path
        if not source_path.exists():
            errors.append(f"{label}:{line_number}: missing source {relative_path}")
            continue
        lines = source_path.read_text(encoding="utf-8").splitlines(keepends=True)
        line_start = source.get("line_start")
        line_end = source.get("line_end")
        if not isinstance(line_start, int) or not isinstance(line_end, int) or not (1 <= line_start <= line_end <= len(lines)):
            errors.append(f"{label}:{line_number}: invalid source range {line_start}-{line_end}")
            continue
        expected_content = "".join(lines[line_start - 1 : line_end])
        if record.get("content") != expected_content:
            errors.append(f"{label}:{line_number}: content does not match {relative_path}:{line_start}-{line_end}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="handbook root")
    args = parser.parse_args()
    root = args.root.resolve()
    ai_root = root / "ai"
    errors: list[str] = []

    try:
        manifest = json.loads((ai_root / "manifest.json").read_text(encoding="utf-8"))
        terms_data = json.loads((ai_root / "terms.json").read_text(encoding="utf-8"))
        english_terms_data = json.loads((ai_root / "terms.en.json").read_text(encoding="utf-8"))
        records = read_jsonl(ai_root / "catalog.jsonl", errors)
        english_records = read_jsonl(ai_root / "catalog.en.jsonl", errors)
    except (OSError, json.JSONDecodeError, KeyError) as exc:
        print(f"AI catalog validation failed: {exc}")
        return 1

    stats = manifest.get("stats", {})
    documents = manifest.get("documents", [])
    english_documents = manifest.get("english_documents", [])
    terms = terms_data.get("terms", [])
    english_terms = english_terms_data.get("terms", [])
    checks = (
        (stats.get("documents"), len(documents), "documents"),
        (stats.get("records"), len(records), "records"),
        (stats.get("terms"), len(terms), "terms"),
        (stats.get("english_documents"), len(english_documents), "english_documents"),
        (stats.get("english_records"), len(english_records), "english_records"),
        (stats.get("english_terms"), len(english_terms), "english_terms"),
    )
    for expected, actual, label in checks:
        if expected != actual:
            errors.append(f"manifest stats.{label} does not match ({expected} != {actual})")

    validate_terms(terms, "zh-CN", "content/12-reference/glossary.md", errors, "terms.json")
    validate_terms(english_terms, "en", "en/12-reference/glossary.md", errors, "terms.en.json")

    source_documents = {
        path.relative_to(root).as_posix()
        for source_root in (root / "content", root / "en")
        for path in source_root.rglob("*.md")
    }
    manifest_sources = {item.get("source") for item in [*documents, *english_documents]}
    if source_documents != manifest_sources:
        missing = sorted(source_documents - manifest_sources)
        extra = sorted(manifest_sources - source_documents)
        errors.append(f"manifest source mismatch; missing={missing}, extra={extra}")

    document_ids = {item.get("id", "") for item in documents}
    english_document_ids = {item.get("id", "") for item in english_documents}
    validate_records(root, records, document_ids, "zh-CN", "content/", "catalog.jsonl", errors)
    validate_records(root, english_records, english_document_ids, "en", "en/", "catalog.en.jsonl", errors)

    if errors:
        print(f"AI catalog validation failed: {len(errors)} error(s)")
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print(
        "AI catalog validation passed: "
        f"{len(documents)} zh-CN documents/{len(records)} records, "
        f"{len(english_documents)} en documents/{len(english_records)} records"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
