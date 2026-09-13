#!/bin/bash
# deploy.sh — ACS v1.6.1 deployment tool
#
# Deploys from the repository source of truth (acs_core/ + adapters/), NOT from
# the versions/ archive. versions/ is legacy (frozen historical snapshots kept
# for reference only) and must not be used as a runtime source.
#
# Usage:
#   ./deploy.sh                    Deploy acs_core/ → ~/.acs_core/ and adapters/claude/ → ~/.claude/hooks/
#   ./deploy.sh --dry-run          Preview changes without applying
#   ./deploy.sh --rollback TIMESTAMP  Restore from backup
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
ACS_VERSION=$(cat "$REPO_ROOT/VERSION" 2>/dev/null || echo "?.?.?")
CORE_SRC="$REPO_ROOT/acs_core"
CLAUDE_ADAPTER_SRC="$REPO_ROOT/adapters/claude/acs_claude.py"

CORE_DST="$HOME/.acs_core"
HOOKS_DST="$HOME/.claude/hooks"
BACKUP_DIR="$REPO_ROOT/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DRY_RUN=false
ROLLBACK_TS=""

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --rollback) ROLLBACK_TS="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# --- Rollback mode ---
if [[ -n "$ROLLBACK_TS" ]]; then
    BACKUP_PATH="$BACKUP_DIR/$ROLLBACK_TS"
    if [[ ! -d "$BACKUP_PATH" ]]; then
        echo "Error: backup '$ROLLBACK_TS' not found in $BACKUP_DIR/"
        exit 1
    fi
    echo "Rolling back to $ROLLBACK_TS ..."
    mkdir -p "$CORE_DST" "$HOOKS_DST"
    cp -v "$BACKUP_PATH"/acs_core_*.py "$CORE_DST/" 2>/dev/null || true
    cp -v "$BACKUP_PATH"/hooks_*.py "$HOOKS_DST/" 2>/dev/null || true
    echo "Rollback complete. Verifying ..."
    python3 "$HOOKS_DST/acs_claude.py" status 2>/dev/null || echo "  (status unavailable)"
    exit 0
fi

# --- Validate source ---
if [[ ! -d "$CORE_SRC" ]]; then
    echo "Error: acs_core/ not found at $CORE_SRC"
    echo "Run from agent-constraint-system/ repo root."
    exit 1
fi
if [[ ! -f "$CLAUDE_ADAPTER_SRC" ]]; then
    echo "Error: Claude adapter not found at $CLAUDE_ADAPTER_SRC"
    exit 1
fi

# --- Snapshot current state ---
BACKUP_PATH="$BACKUP_DIR/$TIMESTAMP"
echo "=== Backing up current deployment → $BACKUP_PATH ==="
if $DRY_RUN; then
    echo "[DRY RUN] mkdir -p $BACKUP_PATH"
else
    mkdir -p "$BACKUP_PATH"
    for f in "$CORE_DST"/*.py; do
        [[ -f "$f" ]] && cp "$f" "$BACKUP_PATH/acs_core_$(basename "$f")"
    done
    for f in "$HOOKS_DST"/*.py; do
        [[ -f "$f" ]] && cp "$f" "$BACKUP_PATH/hooks_$(basename "$f")"
    done
    echo "Backup: $BACKUP_PATH ($(ls "$BACKUP_PATH" | wc -l) files)"
fi

# --- Deploy ---
echo ""
echo "=== Deploying v$ACS_VERSION (from repo source of truth) ==="
echo "  acs_core/   → $CORE_DST"
echo "  adapters/claude/ → $HOOKS_DST"
deployed=0
skipped=0

deploy_file() {
    local src="$1" dst="$2"
    local base=$(basename "$src")
    if [[ -f "$dst" ]] && diff -q "$src" "$dst" > /dev/null 2>&1; then
        skipped=$((skipped + 1))
        return
    fi
    if $DRY_RUN; then
        echo "[DRY RUN] cp $base → $dst"
    else
        cp "$src" "$dst"
        echo "  deployed: $base"
    fi
    deployed=$((deployed + 1))
}

mkdir -p "$CORE_DST" "$HOOKS_DST"
for src in "$CORE_SRC"/*.py; do
    [[ -f "$src" ]] && deploy_file "$src" "$CORE_DST/$(basename "$src")"
done
deploy_file "$CLAUDE_ADAPTER_SRC" "$HOOKS_DST/acs_claude.py"

echo ""
echo "=== Summary ==="
echo "  deployed: $deployed"
echo "  skipped (unchanged): $skipped"
echo "  backup: $BACKUP_PATH"

if $DRY_RUN; then
    echo ""
    echo "[DRY RUN complete — no files modified]"
    exit 0
fi

# --- Post-deploy check ---
echo ""
echo "=== Post-deploy status ==="
python3 "$HOOKS_DST/acs_claude.py" status 2>/dev/null || echo "  (status unavailable — run 'python3 ~/.claude/hooks/acs_claude.py init' to initialize)"

echo ""
echo "Deploy complete. To rollback: ./deploy.sh --rollback $TIMESTAMP"
echo ""
echo "Note: versions/ is a legacy archive and is no longer used for deployment."
echo "      Source of truth = acs_core/ + adapters/ at the repo root."
