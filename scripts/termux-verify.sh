#!/usr/bin/env bash
#
# DeepSeek Harness Android (Termux) Runtime Verification
# ---------------------------------------------------------------------------
# Goal: prove the official DeepSeek Harness Runtime can run on Android
# before any investment in the native APK shell.
#
# Usage (inside Termux):
#   pkg install -y git
#   git clone https://github.com/kamanager2012/dsh-community.git
#   cd dsh-community && bash scripts/termux-verify.sh
#
# The script is intentionally idempotent and writes a machine-readable report
# to $HOME/.dsh/termux-verify.log so results can be quoted in the Reality Gate.
# ---------------------------------------------------------------------------

set -euo pipefail

REPORT="$HOME/.dsh/termux-verify.log"
REQUIRED_NODE_MAJOR=22
DASH_PKG="@deepseek-ai/dsh"
PINNED_DSH_VERSION="0.1.2-alpha.4"
VERIFY_PORT=17890

mkdir -p "$HOME/.dsh"
: > "$REPORT"

say()   { printf '%s\n' "$*" | tee -a "$REPORT"; }
pass()  { say "[PASS] $*"; }
fail()  { say "[FAIL] $*"; }

say "== DSH Android Runtime Verification: $(date -u +%Y-%m-%dT%H:%M:%SZ) =="

# 1. Environment sanity ----------------------------------------------------
if [ ! -d /data/data/com.termux/files/home ]; then
  fail "Not running inside Termux (expected /data/data/com.termux path)."
  exit 1
fi
say "env: Termux detected ($(uname -m))"

if ! command -v node >/dev/null 2>&1; then
  say "node missing, installing via pkg..."
  pkg install -y nodejs-lts 2>&1 | tail -1 || pkg install -y nodejs 2>&1 | tail -1
fi

NODE_MAJOR=$(node -v | sed 's/^v//; s/\..*//')
NODE_FULL=$(node -v)
say "node: $NODE_FULL (major=$NODE_MAJOR)"

if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  fail "Node $REQUIRED_NODE_MAJOR+ required by official runtime (engines: ^22.19.0 || >=24.0.0); got $NODE_FULL"
  exit 1
fi
pass "node engine requirement met"

if ! command -v pnpm >/dev/null 2>&1; then
  say "pnpm missing, installing via corepack..."
  corepack enable 2>&1 | tail -1
fi
say "pnpm: $(pnpm -v)"

# 2. Install the official runtime -------------------------------------------
if ! npm ls -g "$DASH_PKG" >/dev/null 2>&1; then
  say "installing $DASH_PKG globally..."
  npm install -g "$DASH_PKG@$PINNED_DSH_VERSION" 2>&1 | tail -3
fi
DSH_VERSION=$(dsh --version 2>/dev/null || node -e "console.log(require('$DASH_PKG/package.json').version)" 2>/dev/null || echo "unknown")
say "runtime: $DASH_PKG@$DSH_VERSION"
if [ "$DSH_VERSION" != "$PINNED_DSH_VERSION" ]; then
  fail "Expected exact $DASH_PKG@$PINNED_DSH_VERSION; got $DSH_VERSION"
  exit 1
fi
pass "exact official runtime installed"

# 3. Native module probe ----------------------------------------------------
# The known Android risk is native (C++) dependencies. Probe what the runtime
# actually pulls in; report anything that ships prebuilt binaries.
say "native probe:"
node -e "
const fs=require('fs'),path=require('path');
const root=path.dirname(require.resolve('$DASH_PKG/package.json'));
const names=[];
(function walk(d){for(const f of fs.readdirSync(d)){const p=path.join(d,f);let s;try{s=fs.statSync(p)}catch{continue}
 if(s.isDirectory()){if(f!=='node_modules'&&f!=='.git')walk(p)}
 else if(f==='package.json'){try{const j=JSON.parse(fs.readFileSync(p));for(const k of Object.keys(j.dependencies||{})){if(/sqlite|tree-sitter|sharp|onnx|esbuild|@swc|fsevents|better-sqlite/i.test(k))names.push(k)}}}catch{}}})(
 path.join(root,'node_modules'));console.log(names.length?names.join('\n'):'(none detected)')" 2>&1 | tee -a "$REPORT"

# 4. Runtime smoke: start `dsh web` and probe the local UI -------------------
say "runtime smoke: starting '$DASH_PKG web' on 127.0.0.1:$VERIFY_PORT ..."
dsh web --host 127.0.0.1 --port "$VERIFY_PORT" --no-open >"$HOME/.dsh/termux-dsh.log" 2>&1 &
DSH_PID=$!
trap 'kill $DSH_PID 2>/dev/null || true' EXIT

OK=0
for i in $(seq 1 30); do
  if curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$VERIFY_PORT/" 2>/dev/null | grep -qE '200|301|302|303'; then
    OK=1; break
  fi
  sleep 1
done

if [ "$OK" -eq 1 ]; then
  pass "runtime web UI reachable at http://127.0.0.1:$VERIFY_PORT/"
else
  fail "runtime web UI not reachable; tail of log:"
  tail -20 "$HOME/.dsh/termux-dsh.log" >> "$REPORT"
  exit 1
fi

# 5. Approval / tool-chain sanity (best effort) ------------------------------
say "note: interactive approval and tool execution require the SDK JSON-RPC path;"
say "      run a manual session with a real key before claiming [REAL]."

say ""
say "== Result: Android (Termux) runtime verification $( [ "$OK" -eq 1 ] && echo PASSED || echo FAILED ) =="
say "full log: $REPORT"
