#!/bin/bash
# One-line installer for Agent Constraint System
# curl -fsSL https://raw.githubusercontent.com/kamanager2012/agent-constraint-system/main/install-remote.sh | bash

set -e
INSTALL_DIR="$HOME/.acs"

V=$(curl -fsSL https://raw.githubusercontent.com/kamanager2012/agent-constraint-system/main/VERSION 2>/dev/null || echo "?.?.?")
echo "ACS v$V — Agent Constraint System"
echo ""

# Download from GitHub
TMP=$(mktemp -d)
git clone --depth 1 https://github.com/kamanager2012/agent-constraint-system.git "$TMP" 2>/dev/null

cd "$TMP"
bash install.sh --all

rm -rf "$TMP"
echo ""
echo "Done. Run: acs status"
