#!/usr/bin/env python3
"""
session_memory.py — Stop hook: 会话结束时自动提取讨论主题写入项目记忆

触发: Stop hook (stdin JSON 含 transcript_path, cwd)
输出: ~/.claude/projects/<hash>/memory/session_YYYY-MM-DD.md
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path

CLAUDE_DIR = Path.home() / ".claude"
MAX_MESSAGES = 25
MIN_TEXT_LEN = 8
MIN_SESSION_MESSAGES = 3

TRACKED_WRITE_PATTERNS = ["docs/specs/", "docs/FROZEN_", ".claude/projects/"]


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


def extract_user_messages(jsonl_path: Path) -> list[str]:
    messages: list[str] = []
    try:
        lines = jsonl_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except Exception:
        return messages

    for line in lines:
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("type") != "user":
            continue
        content = d.get("message", {}).get("content", "")
        texts: list[str] = []
        if isinstance(content, str):
            texts = [content]
        elif isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    texts.append(item.get("text", ""))

        for text in texts:
            text = text.strip()
            if not text or text.startswith("<") or len(text) < MIN_TEXT_LEN:
                continue
            text = re.sub(r"\s+", " ", text)
            messages.append(text[:200])

    return messages[-MAX_MESSAGES:]


def find_written_specs(jsonl_path: Path) -> list[str]:
    specs: list[str] = []
    try:
        lines = jsonl_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except Exception:
        return specs

    for line in lines:
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get("type") != "user":
            continue
        content = d.get("message", {}).get("content", [])
        if not isinstance(content, list):
            continue
        for item in content:
            if not isinstance(item, dict):
                continue
            inner = item.get("content", "")
            if isinstance(inner, str):
                for pat in TRACKED_WRITE_PATTERNS:
                    if pat in inner:
                        m = re.search(r"[\w\-/]+\.md", inner)
                        if m and m.group() not in specs:
                            specs.append(m.group())
    return specs


def write_session_log(memory_dir: Path, messages: list[str], specs: list[str]) -> None:
    date_str = datetime.now().strftime("%Y-%m-%d")
    time_str = datetime.now().strftime("%H:%M")
    session_file = memory_dir / f"session_{date_str}.md"

    lines = [f"\n## {time_str}\n"]
    if specs:
        lines.append("**本次写入文档:**")
        for s in specs:
            lines.append(f"- `{s}`")
        lines.append("")
    lines.append("**讨论主题（用户消息摘录）:**")
    for msg in messages:
        lines.append(f"- {msg}")
    lines.append("")

    entry = "\n".join(lines)

    if session_file.exists():
        with open(session_file, "a", encoding="utf-8") as f:
            f.write(entry)
    else:
        with open(session_file, "w", encoding="utf-8") as f:
            f.write(f"# 会话记录 {date_str}\n{entry}")

    memory_md = memory_dir / "MEMORY.md"
    if memory_md.exists():
        existing = memory_md.read_text(encoding="utf-8")
        ref = f"session_{date_str}.md"
        if ref not in existing:
            with open(memory_md, "a", encoding="utf-8") as f:
                f.write(f"\n- [会话记录 {date_str}]({ref}) — 当日讨论主题存档")


def main() -> None:
    try:
        hook_data = json.load(sys.stdin)
    except Exception:
        hook_data = {}

    transcript_path_str = hook_data.get("transcript_path", "")
    cwd = hook_data.get("cwd", "")

    if transcript_path_str and Path(transcript_path_str).exists():
        jsonl_path = Path(transcript_path_str)
    else:
        candidates = list((CLAUDE_DIR / "projects").glob("*/*.jsonl"))
        if not candidates:
            sys.exit(0)
        jsonl_path = max(candidates, key=lambda p: p.stat().st_mtime)
        if not cwd:
            hash_dir = jsonl_path.parent.name
            cwd = hash_dir.replace("-", "/").lstrip("/")
            cwd = "/" + cwd

    memory_dir = get_memory_dir(cwd)
    if not memory_dir:
        sys.exit(0)

    messages = extract_user_messages(jsonl_path)
    if len(messages) < MIN_SESSION_MESSAGES:
        sys.exit(0)

    specs = find_written_specs(jsonl_path)
    write_session_log(memory_dir, messages, specs)


if __name__ == "__main__":
    main()
