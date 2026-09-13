#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ACS_ENGINE="${SCRIPT_DIR}/acs_lite.py"

usage() {
    echo "Usage: acs_task.sh <task_id> <dir1,dir2,...> [blocked_cmd_regex,...]"
    echo ""
    echo "  task_id             Task identifier"
    echo "  dir1,dir2,...       Comma-separated allowed directories"
    echo "  blocked_cmd_regex   Optional comma-separated command patterns to block"
    echo ""
    echo "Example:"
    echo "  acs_task.sh my-feature src/,tests/ 'rm\\s+-rf,git\\s+push'"
    exit 1
}

if [[ $# -lt 2 ]]; then
    usage
fi

if [[ ! -f "$ACS_ENGINE" ]]; then
    echo "[ERROR] ACS engine not found: $ACS_ENGINE" >&2
    exit 1
fi

python3 "$ACS_ENGINE" init "$@"
