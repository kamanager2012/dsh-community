#!/usr/bin/env python3
"""Build the deterministic AI retrieval package from the handbook source.

The Markdown under ``content/`` remains the source of truth.  This script only
extracts document metadata and exact Markdown sections; it does not ask a
model to summarize, rewrite, or invent claims.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "content"
EN_SOURCE_ROOT = ROOT / "en"
AI_ROOT = ROOT / "ai"
CATALOG_PATH = AI_ROOT / "catalog.jsonl"
EN_CATALOG_PATH = AI_ROOT / "catalog.en.jsonl"
MANIFEST_PATH = AI_ROOT / "manifest.json"
EN_TERMS_PATH = AI_ROOT / "terms.en.json"
MAX_CHUNK_CHARS = 7200
REPOSITORY_URL = "https://github.com/kamanager2012/deepseek-harness-handbook"

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
INLINE_LINK_RE = re.compile(r"\[([^]]+)\]\([^)]*\)")
INLINE_MARKUP_RE = re.compile(r"[`*_~]")
TERM_RE = re.compile(r"[A-Za-z][A-Za-z0-9+._/-]{1,}|[\u4e00-\u9fff]{2,}")

KIND_BY_DIRECTORY = {
    "00-overview": "overview",
    "01-installation": "installation",
    "02-web-ui": "web-ui",
    "03-cli": "cli",
    "04-providers": "provider",
    "05-workflows": "workflow",
    "06-security": "security",
    "07-sessions": "session",
    "08-automation": "automation",
    "09-tools": "tools",
    "10-plugins": "plugin",
    "11-operations": "operations",
    "12-reference": "reference",
    "core": "core",
    "quickstart": "quickstart",
    "tasks": "task",
    "automation": "automation",
    "safety": "security",
}


def heading(line: str) -> tuple[int, str] | None:
    match = HEADING_RE.match(line.rstrip("\r\n"))
    if not match:
        return None
    return len(match.group(1)), match.group(2).strip()


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def plain_text(text: str) -> str:
    text = INLINE_LINK_RE.sub(r"\1", text)
    text = INLINE_MARKUP_RE.sub("", text)
    return compact(text)


def first_summary(text: str, fallback: str) -> str:
    """Return an exact, lightly cleaned first prose paragraph."""

    paragraphs = re.split(r"\n\s*\n", text)
    for paragraph in paragraphs:
        lines = []
        in_fence = False
        for raw_line in paragraph.splitlines():
            line = raw_line.strip()
            if line.startswith(("```", "~~~")):
                in_fence = not in_fence
                continue
            if in_fence or not line or line.startswith("#"):
                continue
            if line.startswith((">", "|")):
                continue
            lines.append(line)
        candidate = plain_text(" ".join(lines))
        if candidate:
            return candidate[:480].rstrip() + ("…" if len(candidate) > 480 else "")
    return fallback


def slug(value: str) -> str:
    value = value.lower().replace("`", "")
    value = re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "-", value)
    return value.strip("-") or "section"


def unique(values: Iterable[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        value = compact(value)
        if not value:
            continue
        key = value.lower()
        if key not in seen:
            seen.add(key)
            result.append(value)
    return result


def document_kind(relative_path: Path) -> str:
    directory = relative_path.parent.name
    if relative_path.name in {"faq.md", "troubleshooting.md"}:
        return "troubleshooting"
    return KIND_BY_DIRECTORY.get(directory, "guide")


def keywords(relative_path: Path, title: str, headings: list[str]) -> list[str]:
    path_terms = []
    for part in relative_path.parts[:-1]:
        path_terms.append(re.sub(r"^\d+-", "", part).replace("-", " "))
    heading_terms: list[str] = []
    for value in [title, *headings]:
        heading_terms.extend(TERM_RE.findall(value))
    return unique(
        [
            "dsh",
            "DeepSeek Harness",
            *path_terms,
            title,
            *headings,
            *heading_terms,
        ]
    )[:80]


def split_large_ranges(lines: list[str], start: int, end: int) -> list[tuple[int, int]]:
    """Split a source range at paragraph boundaries when it is very large."""

    if start >= end:
        return []
    if sum(len(line) for line in lines[start:end]) <= MAX_CHUNK_CHARS:
        return [(start, end)]

    ranges: list[tuple[int, int]] = []
    current_start = start
    current_size = 0
    in_fence = False
    for index in range(start, end):
        line = lines[index]
        current_size += len(line)
        stripped = line.strip()
        if stripped.startswith(("```", "~~~")):
            in_fence = not in_fence
        at_boundary = not in_fence and not stripped
        hard_boundary = not in_fence and current_size >= int(MAX_CHUNK_CHARS * 1.35)
        if (at_boundary and current_size >= MAX_CHUNK_CHARS) or hard_boundary:
            ranges.append((current_start, index + 1))
            current_start = index + 1
            current_size = 0
    if current_start < end:
        ranges.append((current_start, end))
    return ranges


def source_ranges(lines: list[str], intro_title: str) -> list[tuple[str, int, int]]:
    headings: list[tuple[int, int, str]] = []
    for index, line in enumerate(lines):
        value = heading(line)
        if value:
            headings.append((index, value[0], value[1]))

    h2_positions = [item for item in headings if item[1] == 2]
    if not h2_positions:
        return [("正文" if intro_title == "导语" else "Body", 0, len(lines))]

    ranges: list[tuple[str, int, int]] = []
    first_h2 = h2_positions[0][0]
    if first_h2 > 0 and plain_text("".join(lines[:first_h2])):
        ranges.append((intro_title, 0, first_h2))

    for offset, (start, _level, title) in enumerate(h2_positions):
        end = h2_positions[offset + 1][0] if offset + 1 < len(h2_positions) else len(lines)
        ranges.append((title, start, end))
    return ranges


def build_records(root: Path, source_root: Path, language: str, id_namespace: str, intro_title: str) -> tuple[list[dict], list[dict]]:
    records: list[dict] = []
    documents: list[dict] = []
    for source_path in sorted(source_root.rglob("*.md")):
        relative_path = source_path.relative_to(ROOT)
        id_path = source_path.relative_to(source_root)
        lines = source_path.read_text(encoding="utf-8").splitlines(keepends=True)
        title = next((value[1] for value in (heading(line) for line in lines) if value and value[0] == 1), source_path.stem)
        all_headings = [value[1] for value in (heading(line) for line in lines) if value]
        kind = document_kind(relative_path)
        document_id = "dsh." + id_namespace + "." + ".".join(id_path.with_suffix("").parts)
        doc_summary = first_summary("".join(lines), title)
        doc_keywords = keywords(relative_path, title, all_headings)
        section_count = 0
        seen_slugs: dict[str, int] = {}

        for section_index, (section_title, start, end) in enumerate(source_ranges(lines, intro_title), start=1):
            for part_index, (part_start, part_end) in enumerate(split_large_ranges(lines, start, end), start=1):
                section_count += 1
                section_slug = slug(section_title)
                seen_slugs[section_slug] = seen_slugs.get(section_slug, 0) + 1
                if seen_slugs[section_slug] > 1:
                    section_slug += f"-{seen_slugs[section_slug]}"
                part_suffix = f".part-{part_index}" if len(split_large_ranges(lines, start, end)) > 1 else ""
                record_id = f"{document_id}.{section_slug}{part_suffix}"
                content = "".join(lines[part_start:part_end])
                source_url = (
                    f"{REPOSITORY_URL}/blob/main/{relative_path.as_posix()}"
                    f"#L{part_start + 1}-L{part_end}"
                )
                records.append(
                    {
                        "schema_version": "1.0",
                        "id": record_id,
                        "document_id": document_id,
                        "title": title,
                        "section_title": section_title,
                        "section_index": section_index,
                        "part_index": part_index,
                        "kind": kind,
                        "language": language,
                        "summary": first_summary(content, section_title),
                        "keywords": doc_keywords,
                        "content": content,
                        "source": {
                            "path": relative_path.as_posix(),
                            "line_start": part_start + 1,
                            "line_end": part_end,
                            "url": source_url,
                        },
                    }
                )

                source_info = {
                    "path": relative_path.as_posix(),
                    "line_start": part_start + 1,
                    "line_end": part_end,
                    "url": source_url,
                }
                if language == "en":
                    translated_path = Path("content") / id_path
                    if not (root / translated_path).exists() and id_path == Path("index.md"):
                        translated_path = Path("index.md")
                    if (root / translated_path).exists():
                        source_info["translation_of"] = translated_path.as_posix()
                        source_info["translation_url"] = f"{REPOSITORY_URL}/blob/main/{translated_path.as_posix()}"
                records[-1]["source"] = source_info

        documents.append(
            {
                "id": document_id,
                "title": title,
                "kind": kind,
                "summary": doc_summary,
                "keywords": doc_keywords,
                "source": relative_path.as_posix(),
                "language": language,
                "section_count": section_count,
            }
        )
    return records, documents


def build_terms(root: Path, source_relative_path: str, language: str) -> list[dict]:
    path = root / source_relative_path
    lines = path.read_text(encoding="utf-8").splitlines()
    terms: list[dict] = []
    for line_number, line in enumerate(lines, start=1):
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 2 or cells[0] in {"术语", "Term", "---"} or set(cells[0]) <= {"-", ":"}:
            continue
        term, definition = cells[0], cells[1]
        translation_of = "content/12-reference/glossary.md" if language == "en" else None
        source = {
            "path": source_relative_path,
            "line_start": line_number,
            "line_end": line_number,
            "url": f"{REPOSITORY_URL}/blob/main/{source_relative_path}#L{line_number}",
        }
        if translation_of:
            source["translation_of"] = translation_of
            source["translation_url"] = f"{REPOSITORY_URL}/blob/main/{translation_of}"
        terms.append(
            {
                "term": term,
                "definition": definition,
                "language": language,
                "source": source,
            }
        )
    return terms


def render(
    records: list[dict],
    documents: list[dict],
    terms: list[dict],
    english_records: list[dict],
    english_documents: list[dict],
    english_terms: list[dict],
) -> tuple[str, str, str, str, str]:
    catalog = "".join(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in records)
    english_catalog = "".join(
        json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n" for record in english_records
    )

    def terms_document(name: str, description: str, language: str, source_path: str, values: list[dict]) -> str:
        return json.dumps(
            {
                "schema_version": "1.0",
                "name": name,
                "description": description,
                "language": language,
                "source": {
                    "path": source_path,
                    "repository": REPOSITORY_URL,
                    "branch": "main",
                },
                "terms": values,
            },
            ensure_ascii=False,
            indent=2,
        ) + "\n"

    terms_json = terms_document(
        "DeepSeek Harness 术语索引",
        "从中文正文术语表逐行提取的机器可读定义，不替代当前版本官方字段说明。",
        "zh-CN",
        "content/12-reference/glossary.md",
        terms,
    )
    english_terms_json = terms_document(
        "DeepSeek Harness Glossary Index",
        "Machine-readable definitions extracted line by line from the initial English glossary translation.",
        "en",
        "en/12-reference/glossary.md",
        english_terms,
    )
    manifest = {
        "schema_version": "1.0",
        "package": {
            "id": "deepseek-harness-handbook",
            "name": "DeepSeek Harness bilingual AI knowledge package",
            "description": "AI retrieval records for the Chinese source handbook and its maintained English edition.",
            "languages": ["zh-CN", "en"],
            "source_of_truth": "Chinese Markdown under content/; English Markdown under en/ is a maintained translation.",
            "transformation": "deterministic section extraction; no model-generated claims",
        },
        "source": {
            "repository": REPOSITORY_URL,
            "branch": "main",
            "primary_root": "content/",
            "translation_root": "en/",
            "included": ["content/**/*.md", "en/**/*.md"],
            "excluded": ["evidence/**", "labs/**", "BOOK.md"],
        },
        "retrieval": {
            "format": "JSON Lines (UTF-8)",
            "entry_files": {"zh-CN": "catalog.jsonl", "en": "catalog.en.jsonl"},
            "record_unit": "one Markdown H2 section or a bounded part of one section",
            "recommended_fields": ["title", "section_title", "summary", "content", "source", "keywords"],
        },
        "files": {
            "catalog": "catalog.jsonl",
            "catalog_en": "catalog.en.jsonl",
            "terms": "terms.json",
            "terms_en": "terms.en.json",
            "schema": "schema.json",
            "usage": "README.md",
        },
        "stats": {
            "documents": len(documents),
            "records": len(records),
            "terms": len(terms),
            "english_documents": len(english_documents),
            "english_records": len(english_records),
            "english_terms": len(english_terms),
        },
        "documents": documents,
        "english_documents": english_documents,
    }
    return (
        catalog,
        english_catalog,
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        terms_json,
        english_terms_json,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="handbook root")
    parser.add_argument("--check", action="store_true", help="check generated files without writing")
    args = parser.parse_args()
    root = args.root.resolve()
    global SOURCE_ROOT, EN_SOURCE_ROOT, AI_ROOT, CATALOG_PATH, EN_CATALOG_PATH, MANIFEST_PATH, EN_TERMS_PATH
    SOURCE_ROOT = root / "content"
    EN_SOURCE_ROOT = root / "en"
    AI_ROOT = root / "ai"
    CATALOG_PATH = AI_ROOT / "catalog.jsonl"
    EN_CATALOG_PATH = AI_ROOT / "catalog.en.jsonl"
    MANIFEST_PATH = AI_ROOT / "manifest.json"
    EN_TERMS_PATH = AI_ROOT / "terms.en.json"
    terms_path = AI_ROOT / "terms.json"

    records, documents = build_records(root, SOURCE_ROOT, "zh-CN", "content", "导语")
    english_records, english_documents = build_records(root, EN_SOURCE_ROOT, "en", "en", "Introduction")
    terms = build_terms(root, "content/12-reference/glossary.md", "zh-CN")
    english_terms = build_terms(root, "en/12-reference/glossary.md", "en")
    catalog, english_catalog, manifest, terms_json, english_terms_json = render(
        records, documents, terms, english_records, english_documents, english_terms
    )
    expected = {
        CATALOG_PATH: catalog,
        EN_CATALOG_PATH: english_catalog,
        MANIFEST_PATH: manifest,
        terms_path: terms_json,
        EN_TERMS_PATH: english_terms_json,
    }
    mismatches: list[str] = []
    for path, content in expected.items():
        if not path.exists() or path.read_text(encoding="utf-8") != content:
            mismatches.append(str(path.relative_to(root)))

    if args.check:
        if mismatches:
            print("AI catalog is out of date: " + ", ".join(mismatches))
            print("Run: python3 scripts/build_ai_catalog.py")
            return 1
        print(
            "AI catalog is current: "
            f"{len(documents)} zh-CN documents/{len(records)} records, "
            f"{len(english_documents)} en documents/{len(english_records)} records"
        )
        return 0

    AI_ROOT.mkdir(parents=True, exist_ok=True)
    for path, content in expected.items():
        path.write_text(content, encoding="utf-8")
    print(
        "AI catalog built: "
        f"{len(documents)} zh-CN documents/{len(records)} records, "
        f"{len(english_documents)} en documents/{len(english_records)} records"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
