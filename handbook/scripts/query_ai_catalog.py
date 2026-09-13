#!/usr/bin/env python3
"""Search the static AI catalog without external dependencies."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "ai/catalog.jsonl"
TERM_RE = re.compile(r"[A-Za-z][A-Za-z0-9+._/-]{1,}|[\u4e00-\u9fff]+")

QUERY_ALIASES = {
    "参数不确定": ["--help", "帮助"],
    "不确定参数": ["--help", "帮助"],
    "旧消息": ["history", "历史"],
    "恢复 session": ["resume", "恢复"],
    "恢复 Session": ["resume", "恢复"],
    "分叉": ["fork"],
    "脚本化": ["基本调用"],
    "术语": ["glossary", "definition"],
    "what does": ["glossary", "definition"],
    "what is": ["definition"],
    "mean": ["glossary", "definition"],
}

# English questions contain many words that occur in almost every handbook
# section. Keeping them out of the weighted substring scorer makes the
# language-neutral baseline useful without introducing a tokenizer dependency.
ENGLISH_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "be",
    "can",
    "do",
    "does",
    "for",
    "from",
    "how",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "should",
    "that",
    "the",
    "this",
    "to",
    "was",
    "what",
    "when",
    "which",
    "why",
    "with",
}

# These are question-form fragments rather than knowledge-bearing terms. The
# scorer uses character n-grams for Chinese, so filtering them here prevents a
# generic "什么时候" from overpowering a specific topic such as sessions or
# providers.
CJK_QUERY_NOISE = (
    "什么时候",
    "为什么",
    "如何",
    "怎么",
    "是否",
    "哪些",
    "哪个",
    "哪种",
    "什么",
    "应该",
    "可以",
    "需要",
    "时候",
    "么时",
    "何用",
)
CJK_SINGLE_STOPWORDS = {"的", "和", "或", "在", "里", "吗", "呢", "要", "给", "把", "让", "用", "先"}


def terms(value: str) -> list[str]:
    result: list[str] = []
    lowered = value.lower()
    for part in TERM_RE.findall(lowered):
        if re.fullmatch(r"[\u4e00-\u9fff]+", part):
            if len(part) > 1 and not any(noise in part for noise in CJK_QUERY_NOISE):
                result.append(part)
            for size in (2, 3, 4):
                result.extend(
                    fragment
                    for index in range(len(part) - size + 1)
                    if (fragment := part[index : index + size])
                    and not any(noise in fragment for noise in CJK_QUERY_NOISE)
                )
        else:
            if part not in ENGLISH_STOPWORDS:
                result.append(part)
    result = [
        term
        for term in result
        if term not in CJK_SINGLE_STOPWORDS
        and not (len(term) > 1 and any(noise in term for noise in CJK_QUERY_NOISE))
    ]
    for phrase, aliases in QUERY_ALIASES.items():
        if phrase.lower() in lowered:
            result.extend(aliases)
    return list(dict.fromkeys(term for term in result if term))


def score(record: dict, query_terms: list[str]) -> int:
    title = str(record.get("title", "")).lower()
    section = str(record.get("section_title", "")).lower()
    summary = str(record.get("summary", "")).lower()
    keywords = " ".join(str(value).lower() for value in record.get("keywords", []))
    content = str(record.get("content", "")).lower()
    source_path = str(record.get("source", {}).get("path", "")).lower()
    total = 0
    for term in query_terms:
        if term in title:
            total += 12
        if term in section:
            total += 9
        if term == title or term == section:
            total += 18
        if term in keywords:
            total += 5
        if term in source_path:
            total += 14
        if term in summary:
            total += 3
        if term in content:
            total += 1
    return total


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query", help="natural-language search query")
    parser.add_argument("--catalog", type=Path, default=CATALOG)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument("--full", action="store_true", help="include full Markdown content")
    args = parser.parse_args()
    query_terms = terms(args.query)
    if not query_terms:
        raise SystemExit("query must contain searchable text")

    results = []
    with args.catalog.open(encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            value = score(record, query_terms)
            if value:
                item = {
                    "score": value,
                    "id": record["id"],
                    "title": record["title"],
                    "section_title": record["section_title"],
                    "summary": record["summary"],
                    "source": record["source"],
                }
                if args.full:
                    item["content"] = record["content"]
                results.append(item)

    results.sort(key=lambda item: (-item["score"], item["id"]))
    print(json.dumps(results[: max(args.limit, 0)], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
