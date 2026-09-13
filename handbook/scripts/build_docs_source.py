#!/usr/bin/env python3
"""Prepare the reader-only source tree used by MkDocs.

The repository root remains the canonical Markdown source. MkDocs requires
its docs_dir to be a child directory of the configuration file, so the build
copies only the public reader pages into a disposable sibling tree first.
"""

from __future__ import annotations

import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / ".mkdocs-docs"


def main() -> None:
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir()

    for name in ("index.md", "BOOK.md"):
        shutil.copy2(ROOT / name, OUTPUT / name)

    shutil.copytree(ROOT / "content", OUTPUT / "content")
    shutil.copytree(ROOT / "ai", OUTPUT / "ai")
    shutil.copytree(ROOT / "en", OUTPUT / "en")


if __name__ == "__main__":
    main()
