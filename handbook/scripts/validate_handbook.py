#!/usr/bin/env python3
"""Validate the evidence and navigation contracts of the handbook.

This is intentionally a read-only check. It does not execute dsh, inspect
credentials, or touch a test workspace. Runtime/model claims still require a
separate Lab Evidence Record.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any


try:
    import yaml
except ImportError as exc:  # pragma: no cover - exercised by the CLI environment
    raise SystemExit("validate_handbook.py requires PyYAML") from exc


SENSITIVE_PATTERNS = (
    re.compile(r"harness-engineering-orange-book"),
    re.compile(r"deepseek-harness-orange-book"),
    re.compile(r"sk-[A-Za-z0-9]{10,}"),
    re.compile(r"/home/"),
    re.compile(r"/Users/"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN (?:RSA|OPENSSH|PRIVATE) KEY-----"),
)

GENERATED_DIRS = {".mkdocs-docs", ".mkdocs-site", ".venv", "__pycache__"}


def is_generated(path: Path, root: Path) -> bool:
    return any(part in GENERATED_DIRS for part in path.relative_to(root).parts)


def load_yaml(path: Path) -> Any:
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError(f"{path}: invalid YAML: {exc}") from exc


def add_error(errors: list[str], message: str) -> None:
    errors.append(message)


def check_evidence(root: Path, errors: list[str]) -> tuple[set[str], int]:
    schema = load_yaml(root / "evidence/schema.yaml")
    required = set(schema["required"])
    layers = set(schema["layers"])
    statuses = set(schema["statuses"])
    record_ids: set[str] = set()
    record_count = 0

    for path in sorted((root / "evidence/records").glob("*.yaml")):
        record_count += 1
        data = load_yaml(path) or {}
        missing = required - set(data)
        if missing:
            add_error(errors, f"{path}: missing required fields {sorted(missing)}")
        if data.get("layer") not in layers:
            add_error(errors, f"{path}: unknown evidence layer {data.get('layer')!r}")
        if data.get("status") not in statuses:
            add_error(errors, f"{path}: unknown status {data.get('status')!r}")
        record_id = data.get("id")
        if not isinstance(record_id, str):
            add_error(errors, f"{path}: id must be a string")
        elif record_id in record_ids:
            add_error(errors, f"{path}: duplicate record id {record_id}")
        else:
            record_ids.add(record_id)

    for path in sorted((root / "evidence/records").glob("*.md")):
        record_ids.add(path.stem)

    return record_ids, record_count


def check_matrix(root: Path, record_ids: set[str], errors: list[str]) -> None:
    matrix = load_yaml(root / "evidence/source-matrix.yaml") or {}
    for topic in matrix.get("topics", []):
        topic_id = topic.get("id", "<unknown-topic>")
        for field in ("official_records", "implementation_records", "observation_records"):
            for record_id in topic.get(field, []):
                if record_id not in record_ids:
                    add_error(errors, f"{topic_id}.{field}: missing record {record_id}")


def check_manifest(root: Path, errors: list[str]) -> None:
    manifest = load_yaml(root / "labs/manifest.yaml") or {}
    for lab in manifest.get("labs", []):
        task_contract = (lab.get("evidence") or {}).get("task_contract")
        if task_contract and not (root / task_contract).exists():
            add_error(errors, f"{lab.get('id', '<unknown-lab>')}: missing task contract {task_contract}")


def check_markdown_links(root: Path, errors: list[str]) -> int:
    checked = 0
    for path in sorted(root.rglob("*.md")):
        if is_generated(path, root):
            continue
        text = path.read_text(encoding="utf-8")
        for target in re.findall(r"\]\(([^)]+)\)", text):
            if target.startswith(("http://", "https://", "mailto:", "#")):
                continue
            target = target.split("#", 1)[0]
            if not target:
                continue
            checked += 1
            if not (path.parent / target).resolve().exists():
                add_error(errors, f"{path}: broken relative link {target}")
    return checked


def check_sensitive_strings(root: Path, errors: list[str]) -> int:
    matches = 0
    for path in sorted(root.rglob("*")):
        if is_generated(path, root):
            continue
        if not path.is_file() or path.name == "validate_handbook.py":
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for pattern in SENSITIVE_PATTERNS:
            if pattern.search(text):
                matches += 1
                add_error(errors, f"{path}: sensitive/private pattern {pattern.pattern!r}")
    return matches


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="handbook root (default: parent of scripts/)",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    errors: list[str] = []

    try:
        record_ids, record_count = check_evidence(root, errors)
        check_matrix(root, record_ids, errors)
        check_manifest(root, errors)
        link_count = check_markdown_links(root, errors)
        sensitive_count = check_sensitive_strings(root, errors)
    except (OSError, KeyError, TypeError, ValueError) as exc:
        add_error(errors, str(exc))
        record_count = 0
        link_count = 0
        sensitive_count = 0

    if errors:
        print(f"Handbook validation failed: {len(errors)} error(s)")
        print("\n".join(f"- {error}" for error in errors))
        return 1

    print(
        "Handbook validation passed: "
        f"{record_count} YAML records, {link_count} Markdown relative links, "
        f"{sensitive_count} sensitive-pattern matches"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
