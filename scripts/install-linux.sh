#!/usr/bin/env bash
set -euo pipefail

# One-command WSL/Linux Terminal installer for dsh-community & dsh-marketplace.
# Installs a clean source build under $XDG_DATA_HOME/dsh-community and places
# wrapper shims in ~/.local/bin without npm-publishing private workspace packages
# or modifying the official @deepseek-ai/dsh kernel.

PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/dsh-community"
BIN_DIR="$HOME/.local/bin"
REPO_URL="https://github.com/kamanager2012/dsh-community.git"
REF="${DSH_COMMUNITY_REF:-main}"
EXPECTED_COMMIT="${DSH_COMMUNITY_EXPECTED_COMMIT:-}"
LOCAL_REPO=""
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: install-linux.sh [options]

Install the dsh-community WSL/Linux Terminal CLI (dsh-community) and plugin discovery
CLI (dsh-marketplace) from this repository without cloning manually.
Requires Node.js (>= 24.9.0 recommended, >= 22.15.0 minimum), pnpm, and git.

Options:
  --prefix <dir>            Install workspace directory (default: ~/.local/share/dsh-community)
  --bin-dir <dir>           Directory for dsh-community / dsh-marketplace shims (default: ~/.local/bin)
  --repo-url <url>          Git clone URL (default: https://github.com/kamanager2012/dsh-community.git)
  --ref <ref>               Branch, immutable tag (e.g. v0.2.2-rc.3), or 40-char commit SHA (default: main)
  --branch <ref>            Alias for --ref (kept for compatibility)
  --expected-commit <sha>   Fail closed unless checked-out HEAD matches this 40-char git commit SHA
  --local-repo <dir>        Copy an existing local checkout instead of fetching from GitHub
  --dry-run                 Print planned steps and exit without writing files
  -h, --help                Show this help message
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      [ "$#" -ge 2 ] || { echo "ERROR: --prefix requires a directory" >&2; exit 1; }
      PREFIX="$2"
      shift 2
      ;;
    --bin-dir)
      [ "$#" -ge 2 ] || { echo "ERROR: --bin-dir requires a directory" >&2; exit 1; }
      BIN_DIR="$2"
      shift 2
      ;;
    --repo-url)
      [ "$#" -ge 2 ] || { echo "ERROR: --repo-url requires a URL" >&2; exit 1; }
      REPO_URL="$2"
      shift 2
      ;;
    --ref|--branch)
      [ "$#" -ge 2 ] || { echo "ERROR: $1 requires a git branch, tag, or commit SHA" >&2; exit 1; }
      REF="$2"
      shift 2
      ;;
    --expected-commit)
      [ "$#" -ge 2 ] || { echo "ERROR: --expected-commit requires a 40-char hex SHA" >&2; exit 1; }
      EXPECTED_COMMIT="$2"
      shift 2
      ;;
    --local-repo)
      [ "$#" -ge 2 ] || { echo "ERROR: --local-repo requires a directory" >&2; exit 1; }
      LOCAL_REPO="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -n "$EXPECTED_COMMIT" ]; then
  EXPECTED_COMMIT="$(printf '%s' "$EXPECTED_COMMIT" | tr '[:upper:]' '[:lower:]')"
  case "$EXPECTED_COMMIT" in
    *[!0-9a-f]*|""|???????????????????????????????????????|?????????????????????????????????????????*)
      if ! printf '%s' "$EXPECTED_COMMIT" | grep -Eq '^[0-9a-f]{40}$'; then
        echo "ERROR: --expected-commit must be a 40-character hexadecimal SHA-1 commit hash (got '$EXPECTED_COMMIT')." >&2
        exit 1
      fi
      ;;
  esac
fi

case "$(uname -s)" in
  Linux) ;;
  *)
    echo "ERROR: install-linux.sh is for Linux and WSL2 only (detected $(uname -s))." >&2
    echo "Use official deepseek-harness installers for Windows or macOS." >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed. Install Node.js >= 24.9.0 (minimum 22.15.0) and retry." >&2
  exit 1
fi

NODE_VER="$(node -p 'process.versions.node')"
set +e
node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 15)) process.exit(2);
if (major < 24 || (major === 24 && minor < 9)) process.exit(10);
'
NODE_CHECK_RC=$?
set -e

if [ "$NODE_CHECK_RC" -eq 2 ]; then
  echo "ERROR: Node.js >= 22.15.0 is required for node:zlib zstd session support (found v$NODE_VER)." >&2
  exit 1
elif [ "$NODE_CHECK_RC" -eq 10 ]; then
  echo "WARN: Official @deepseek-ai/dsh recommends Node.js >= 24.9.0; continuing with Node v$NODE_VER (>= 22.15.0)." >&2
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] pnpm not found on PATH; would attempt corepack enable"
  elif command -v corepack >/dev/null 2>&1; then
    echo "pnpm not found; activating pnpm via corepack..."
    corepack enable >/dev/null 2>&1 || true
  fi
fi

if ! command -v pnpm >/dev/null 2>&1 && [ "$DRY_RUN" -eq 0 ]; then
  echo "ERROR: pnpm is required (e.g. npm install -g pnpm@11.21.0 or corepack enable pnpm)." >&2
  exit 1
fi

if [ -z "$LOCAL_REPO" ] && ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git is required unless --local-repo is provided." >&2
  exit 1
fi

resolve_abs_path() {
  node -e 'const path = require("node:path"); process.stdout.write(path.resolve(process.argv[1]))' "$1"
}

PREFIX="$(resolve_abs_path "$PREFIX")"
BIN_DIR="$(resolve_abs_path "$BIN_DIR")"
if [ -n "$LOCAL_REPO" ]; then
  LOCAL_REPO="$(resolve_abs_path "$LOCAL_REPO")"
fi

INSTALL_REPO="$PREFIX/repo"
TUI_ENTRY="$INSTALL_REPO/apps/tui/dist/bin.js"
MARKETPLACE_ENTRY="$INSTALL_REPO/packages/marketplace/bin/dsh-marketplace.js"
OFFICIAL_BIN_DIR="$INSTALL_REPO/packages/dsh-bridge/node_modules/.bin"
TUI_OFFICIAL_BIN_DIR="$INSTALL_REPO/apps/tui/node_modules/.bin"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] node=v$NODE_VER prefix=$PREFIX bin_dir=$BIN_DIR ref=$REF expected_commit=${EXPECTED_COMMIT:-none}"
  if [ -n "$LOCAL_REPO" ]; then
    echo "[dry-run] would copy source from $LOCAL_REPO -> $INSTALL_REPO"
  else
    echo "[dry-run] would fetch $REPO_URL ($REF) -> $INSTALL_REPO"
  fi
  echo "[dry-run] would run pnpm install --frozen-lockfile and build CLI, remote-web PWA, + marketplace packages"
  echo "[dry-run] would write shims in $BIN_DIR: dsh-community, dsh-marketplace"
  exit 0
fi

mkdir -p "$PREFIX" "$BIN_DIR"

# Existing CLI must remain runnable until the new source and build are verified.
if ! command -v flock >/dev/null 2>&1; then
  echo "ERROR: flock (util-linux) is required for safe Linux upgrades." >&2
  exit 1
fi
exec 9>"$PREFIX/.install.lock"
if ! flock -n 9; then
  echo "ERROR: another dsh-community installation is running at $PREFIX." >&2
  exit 1
fi

# Staging and active repository share a filesystem for fast directory rename.
STAGE_REPO="$(mktemp -d "$PREFIX/.repo.stage.XXXXXXXX")"
BACKUP_REPO=""
SWAP_ATTEMPTED=0
HAD_PREVIOUS=0
TUI_SHIM_TMP=""
MARKETPLACE_SHIM_TMP=""

install_cleanup() {
  local status="$?"
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$SWAP_ATTEMPTED" -eq 1 ]; then
    if [ -e "$INSTALL_REPO" ] || [ -L "$INSTALL_REPO" ]; then
      rm -rf -- "$INSTALL_REPO"
    fi
    if [ "$HAD_PREVIOUS" -eq 1 ] && { [ -e "$BACKUP_REPO" ] || [ -L "$BACKUP_REPO" ]; }; then
      if mv -- "$BACKUP_REPO" "$INSTALL_REPO"; then
        BACKUP_REPO=""
        echo "Previous dsh-community installation restored after failed upgrade." >&2
      else
        echo "CRITICAL: restore failed; previous installation preserved at $BACKUP_REPO" >&2
      fi
    fi
  fi
  if [ -n "$STAGE_REPO" ] && [ -d "$STAGE_REPO" ]; then
    rm -rf -- "$STAGE_REPO"
  fi
  if [ -n "$TUI_SHIM_TMP" ] && [ -e "$TUI_SHIM_TMP" ]; then
    rm -f -- "$TUI_SHIM_TMP"
  fi
  if [ -n "$MARKETPLACE_SHIM_TMP" ] && [ -e "$MARKETPLACE_SHIM_TMP" ]; then
    rm -f -- "$MARKETPLACE_SHIM_TMP"
  fi
  if [ "$status" -eq 0 ] && [ -n "$BACKUP_REPO" ] && [ -e "$BACKUP_REPO" ]; then
    rm -rf -- "$BACKUP_REPO"
  fi
}
trap install_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [ -n "$LOCAL_REPO" ]; then
  [ -d "$LOCAL_REPO" ] || { echo "ERROR: --local-repo does not exist: $LOCAL_REPO" >&2; exit 1; }
  case "$PREFIX/" in
    "$LOCAL_REPO/"*) echo "ERROR: --local-repo cannot contain destination prefix." >&2; exit 1 ;;
  esac
  cp -a "$LOCAL_REPO"/. "$STAGE_REPO"/
else
  git init -q "$STAGE_REPO"
  git -C "$STAGE_REPO" remote add origin "$REPO_URL"
  echo "Fetching $REPO_URL ($REF) into temporary staging..."
  git -C "$STAGE_REPO" fetch --depth 1 origin "$REF"
  git -C "$STAGE_REPO" checkout -q --force --detach FETCH_HEAD
fi

RESOLVED_COMMIT=""
if [ -d "$STAGE_REPO/.git" ] && command -v git >/dev/null 2>&1; then
  RESOLVED_COMMIT="$(git -C "$STAGE_REPO" rev-parse HEAD 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"
fi

if [ -n "$EXPECTED_COMMIT" ]; then
  if [ -z "$RESOLVED_COMMIT" ]; then
    echo "ERROR: --expected-commit requires Git metadata in staged source." >&2
    exit 1
  fi
  if [ "$RESOLVED_COMMIT" != "$EXPECTED_COMMIT" ]; then
    echo "ERROR: checked-out commit mismatch: expected $EXPECTED_COMMIT, got $RESOLVED_COMMIT (ref=$REF)." >&2
    exit 1
  fi
  DIRTY_TREE="$(git -C "$STAGE_REPO" status --porcelain=v1 --untracked-files=normal)"
  if [ -n "$DIRTY_TREE" ]; then
    echo "ERROR: staged source has uncommitted or untracked changes while --expected-commit ($EXPECTED_COMMIT) is enforced." >&2
    exit 1
  fi
fi

echo "Installing dependencies and building dsh-community in temporary staging..."
cd "$STAGE_REPO"
pnpm install --frozen-lockfile
pnpm \
  --filter @dsh-community/shared-types \
  --filter @dsh-community/dsh-bridge \
  --filter @dsh-community/remote-adapter \
  --filter @dsh-community/tui-surface \
  --filter @dsh-community/tui \
  --filter @dsh-community/remote-web \
  --filter @dsh-community/marketplace \
  build

[ -s "$STAGE_REPO/apps/tui/dist/bin.js" ] || {
  echo "ERROR: staged TUI entrypoint is missing; existing installation unchanged." >&2
  exit 1
}
[ -s "$STAGE_REPO/packages/marketplace/bin/dsh-marketplace.js" ] || {
  echo "ERROR: staged marketplace entrypoint is missing; existing installation unchanged." >&2
  exit 1
}

# Stable wrapper target remains $PREFIX/repo for backward compatibility.
if [ -e "$INSTALL_REPO" ] || [ -L "$INSTALL_REPO" ]; then
  BACKUP_REPO="$(mktemp -d "$PREFIX/.repo.previous.XXXXXXXX")"
  rmdir "$BACKUP_REPO"
  mv -- "$INSTALL_REPO" "$BACKUP_REPO"
  HAD_PREVIOUS=1
fi
SWAP_ATTEMPTED=1
mv -- "$STAGE_REPO" "$INSTALL_REPO"
STAGE_REPO=""

# Stage wrappers and rename, never truncate an existing working executable.
TUI_SHIM_TMP="$(mktemp "$BIN_DIR/.dsh-community.XXXXXXXX")"
cat > "$TUI_SHIM_TMP" <<EOF
#!/usr/bin/env sh
exec node "$TUI_ENTRY" "\$@"
EOF
chmod 0755 "$TUI_SHIM_TMP"
mv -f -- "$TUI_SHIM_TMP" "$BIN_DIR/dsh-community"
TUI_SHIM_TMP=""

MARKETPLACE_SHIM_TMP="$(mktemp "$BIN_DIR/.dsh-marketplace.XXXXXXXX")"
cat > "$MARKETPLACE_SHIM_TMP" <<EOF
#!/usr/bin/env sh
PATH="$OFFICIAL_BIN_DIR:$TUI_OFFICIAL_BIN_DIR:\$PATH"
export PATH
exec node "$MARKETPLACE_ENTRY" "\$@"
EOF
chmod 0755 "$MARKETPLACE_SHIM_TMP"
mv -f -- "$MARKETPLACE_SHIM_TMP" "$BIN_DIR/dsh-marketplace"
MARKETPLACE_SHIM_TMP=""

echo
echo "Installed commands:"
echo "  $BIN_DIR/dsh-community"
echo "  $BIN_DIR/dsh-marketplace"
echo "Source build provenance:"
echo "  ref=${REF} commit=${RESOLVED_COMMIT:-untracked}"
echo "  Note: Source installs track git refs (--ref v0.2.2-rc.3 --expected-commit <sha40> to pin). Verify release binaries separately with .sha256 + Cosign."

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "NOTE: $BIN_DIR is not currently in your PATH. Add it to your shell profile:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

echo
echo "Next steps:"
echo "  export DEEPSEEK_API_KEY=..."
echo "  dsh-community doctor"
echo "  dsh-community            # start or resume in ~/.dsh"
echo "  dsh-community remote start --engines dsh,claude,codex --host <LAN-IP> --mdns --qr"
echo "  # First-time paired devices receive only observe+prompt; grant approvals explicitly with:"
echo "  #   dsh-community remote grant <deviceId> approve"
