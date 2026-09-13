#!/usr/bin/env python3
"""
doc_memory_tracker.py — PostToolUse hook: Write 到 docs/specs/ 时自动追加 MEMORY.md 指针

触发: PostToolUse, matcher: Write
输入: stdin JSON (tool_name, tool_input.file_path, tool_input.content, cwd)
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

CLAUDE_DIR = Path.home() / ".claude"

TRACKED_PATTERNS = [
    "/docs/specs/",
    "/docs/FROZEN_",
    "/docs/P",
]


def get_memory_dir(cwd: str) -> Path | None:
    if not cwd:
        return None
    hash_part = cwd.replace("/", "-")
    parts = [p for p in hash_part.split("-") if p]
    for i in range(len(parts), 0, -1):
        candidate = CLAUDE_DIR / "projects" / ("-" + "-".join(parts[:i])) / "memory"
        if candidate.exists():
            return candidate
    return None


def extract_title(content: str, filename: str) -> str:
    m = re.search(r"^#\s+(.+)", content, re.MULTILINE)
    if m:
        return m.group(1).strip()[:60]
    return filename.replace(".md", "").replace("_", " ")


def extract_desc(content: str) -> str:
    for line in content.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and not line.startswith(">") and not line.startswith("-") and len(line) > 10:
            return line[:80]
    return ""


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    if data.get("tool_name") != "Write":
        sys.exit(0)

    tool_input = data.get("tool_input", {})
    file_path = tool_input.get("file_path", "")
    content = tool_input.get("content", "")
    cwd = data.get("cwd", "")

    if not any(pat in file_path for pat in TRACKED_PATTERNS):
        sys.exit(0)

    if "MEMORY.md" in file_path:
        sys.exit(0)

    memory_dir = get_memory_dir(cwd)
    if not memory_dir:
        sys.exit(0)

    memory_md = memory_dir / "MEMORY.md"
    if not memory_md.exists():
        sys.exit(0)

    existing = memory_md.read_text(encoding="utf-8")
    fname = Path(file_path).name
    if fname in existing:
        sys.exit(0)

    title = extract_title(content, fname)
    desc = extract_desc(content)
    date = datetime.now().strftime("%Y-%m-%d")

    entry = f"\n- [{title}]({file_path}) — {desc} ({date})"
    with open(memory_md, "a", encoding="utf-8") as f:
        f.write(entry)


if __name__ == "__main__":
    main()
