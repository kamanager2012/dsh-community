#!/bin/bash
# PreToolUse backup hook: backs up files before Edit / rm / cp
# Reads hook input JSON from stdin

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name')
BACKUP_DIR="$HOME/.claude/backups"
TS=$(date +%Y%m%d_%H%M%S)

mkdir -p "$BACKUP_DIR"

do_backup() {
  local path="$1"
  if [ -e "$path" ]; then
    local name=$(echo "$path" | sed 's|^/||;s|/|_|g')
    cp -r "$path" "$BACKUP_DIR/${TS}_${name}.bak" 2>/dev/null
    echo "[Backup] $BACKUP_DIR/${TS}_${name}.bak" >&2
  fi
}

case "$TOOL" in
  Edit)
    FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path')
    [ -n "$FILE" ] && [ -f "$FILE" ] && do_backup "$FILE"
    ;;
  Bash)
    CMD=$(echo "$INPUT" | jq -r '.tool_input.command')
    case "$CMD" in
      rm\ *)
        # Extract non-flag arguments after rm
        PATHS=$(echo "$CMD" | sed 's/^rm[[:space:]]*//' | sed 's/-[a-zA-Z#]*[[:space:]]*//g')
        for p in $PATHS; do
          [ -n "$p" ] && do_backup "$p"
        done
        ;;
      cp\ *)
        # Extract last argument (destination)
        DEST=$(echo "$CMD" | grep -oP '(?<=\s)/[^ ]+(?=\s*$)' | tail -1)
        [ -n "$DEST" ] && do_backup "$DEST"
        ;;
    esac
    ;;
esac
