#!/bin/bash
# enable-cursor.sh — remove Cursor bypass from ACS hooks so they run in Cursor
# Cursor auto-imports Claude hooks from ~/.claude/settings*.json.
# ACS disables itself in Cursor by default. This script re-enables it.

set -e
HOOKS_DIR="${1:-$HOME/.claude/hooks}"
BYPASS_PATTERN='_e.get.*CURSOR_PROJECT_DIR.*CURSOR_VERSION.*CURSOR_AGENT'

echo "Enabling ACS hooks for Cursor in: $HOOKS_DIR"
echo ""

for f in "$HOOKS_DIR"/*.py; do
    if grep -q "$BYPASS_PATTERN" "$f" 2>/dev/null; then
        # Remove the Cursor bypass block (typically lines ~12-17)
        # Pattern: from "Cursor Agent auto-imports" to "raise SystemExit(0)"
        python3 -c "
import re
with open('$f') as fh:
    content = fh.read()
# Remove the bypass comment + guard block
content = re.sub(
    r'# Cursor Agent auto-imports Claude hooks.*?\n_e =.*?\n(?:.*?\n)*?raise SystemExit\(0\)\n?',
    '# [CURSOR ENABLED] ACS now runs in Cursor sessions.\n',
    content, flags=re.DOTALL
)
with open('$f', 'w') as fh:
    fh.write(content)
"
        echo "  enabled: $(basename "$f")"
    fi
done

echo ""
echo "Done. ACS hooks now active in Cursor sessions."
