#!/usr/bin/env bash
set -Eeuo pipefail

# Reproducible real Linux source installer + CLI smoke. No provider calls.
# Usage: bash scripts/e2e/linux-first-run-smoke.sh [evidence-json-path]
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE_OUT="${1:-}"
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: Linux or WSL2 required" >&2
  exit 2
fi
for tool in bash git node pnpm flock; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: missing $tool" >&2; exit 2; }
done
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-first-run.XXXXXXXX")"
trap 'rm -rf "$WORK"' EXIT
fail() {
  echo "FIRST_RUN_FAIL: $*" >&2
  if [[ -f "$WORK/install.log" ]]; then tail -n 60 "$WORK/install.log" >&2; fi
  exit 1
}
SOURCE_SHA="$(git -C "$ROOT" rev-parse --verify HEAD)"
[[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] || fail "cannot resolve a full Git SHA"

# Local bare origin tests --ref and --expected-commit, not a moving main ref.
git init -q --bare "$WORK/origin.git"
# Actions checkout is shallow by default. Permit that shallow boundary only in
# this disposable local bare origin; verified git fetch --depth 1 still works.
git -C "$WORK/origin.git" config receive.shallowUpdate true
git -C "$ROOT" push -q "$WORK/origin.git" HEAD:refs/heads/acceptance
args=(
  --repo-url "file://$WORK/origin.git"
  --ref acceptance
  --expected-commit "$SOURCE_SHA"
  --prefix "$WORK/installed"
  --bin-dir "$WORK/bin"
)
if ! bash "$ROOT/scripts/install-linux.sh" "${args[@]}" >"$WORK/install.log" 2>&1; then
  fail "real pinned source installation/build failed"
fi
grep -Fq "ref=acceptance commit=$SOURCE_SHA" "$WORK/install.log" || fail "commit pin not confirmed"
[[ -s "$WORK/installed/repo/apps/tui/dist/bin.js" ]] || fail "TUI build missing"
[[ -s "$WORK/installed/repo/packages/marketplace/bin/dsh-marketplace.js" ]] || fail "marketplace entrypoint missing"

# Never interact with the runner's own official ~/.dsh, credentials or sessions.
mkdir -p "$WORK/empty-home/.dsh"
run_cli() {
  env -u DEEPSEEK_API_KEY \
    HOME="$WORK/empty-home" \
    DSH_HOME="$WORK/empty-home/.dsh" \
    XDG_CONFIG_HOME="$WORK/empty-home/.config" "$@"
}
run_cli "$WORK/bin/dsh-community" version >"$WORK/version.txt" || fail "version command"
grep -Fq "@deepseek-ai/dsh" "$WORK/version.txt" || fail "missing upstream identity"
run_cli "$WORK/bin/dsh-community" --help >"$WORK/help.txt" || fail "TUI help"
run_cli "$WORK/bin/dsh-community" sessions --porcelain >"$WORK/sessions.txt" || fail "session listing"
grep -Fq "no official sessions under" "$WORK/sessions.txt" || fail "unexpected non-empty session store"
set +e
run_cli "$WORK/bin/dsh-community" doctor >"$WORK/doctor.txt" 2>&1
doctor_rc=$?
set -e
[[ "$doctor_rc" -eq 2 ]] || fail "no-key doctor must exit 2, got $doctor_rc"
grep -Fq "未设置 DEEPSEEK_API_KEY" "$WORK/doctor.txt" || fail "missing-key warning absent"
run_cli "$WORK/bin/dsh-marketplace" --help >"$WORK/marketplace.txt" || fail "marketplace help"
grep -Fq "marketplace list" "$WORK/marketplace.txt" || fail "marketplace command absent"
run_cli "$WORK/bin/dsh-community" remote --help >"$WORK/remote.txt" || fail "remote help"
grep -Fq "remote start" "$WORK/remote.txt" || fail "remote command absent"

# A failed upgrade must not affect the already installed CLI.
mkdir -p "$WORK/fail-tools"
cat > "$WORK/fail-tools/pnpm" <<'SH'
#!/bin/sh
exit 47
SH
chmod 0755 "$WORK/fail-tools/pnpm"
original_hash="$(sha256sum "$WORK/installed/repo/apps/tui/dist/bin.js" | awk '{print $1}')"
set +e
PATH="$WORK/fail-tools:$PATH" bash "$ROOT/scripts/install-linux.sh" "${args[@]}" >"$WORK/fail-upgrade.log" 2>&1
fail_rc=$?
set -e
[[ "$fail_rc" -ne 0 ]] || fail "deliberately failed upgrade unexpectedly succeeded"
after_hash="$(sha256sum "$WORK/installed/repo/apps/tui/dist/bin.js" | awk '{print $1}')"
[[ "$original_hash" = "$after_hash" ]] || fail "failed upgrade changed the working CLI"
run_cli "$WORK/bin/dsh-community" version >"$WORK/after-failure.txt" \
  || fail "CLI could not run after failed upgrade"
grep -Fq "@deepseek-ai/dsh" "$WORK/after-failure.txt" \
  || fail "official Runtime identity lost after failed upgrade"

# Another installer must refuse immediately under the same prefix lock.
exec 8>"$WORK/installed/.install.lock"
flock -x 8
set +e
bash "$ROOT/scripts/install-linux.sh" "${args[@]}" >"$WORK/concurrent.log" 2>&1
concurrent_rc=$?
set -e
flock -u 8
exec 8>&-
[[ "$concurrent_rc" -ne 0 ]] || fail "concurrent installation unexpectedly succeeded"
grep -Fq "another dsh-community installation" "$WORK/concurrent.log" \
  || fail "lock refusal did not explain the concurrent installation"
[[ "$(sha256sum "$WORK/installed/repo/apps/tui/dist/bin.js" | awk '{print $1}')" = "$original_hash" ]] \
  || fail "concurrent rejection modified active CLI"

if [[ -n "$EVIDENCE_OUT" ]]; then
  mkdir -p "$(dirname "$EVIDENCE_OUT")"
  SOURCE_SHA="$SOURCE_SHA" EVIDENCE_OUT="$EVIDENCE_OUT" node <<'NODE'
const fs = require('node:fs')
const evidence = {
  schemaVersion: 1,
  scenario: 'isolated-linux-real-source-install',
  sourceCommit: process.env.SOURCE_SHA,
  platform: process.platform,
  architecture: process.arch,
  nodeVersion: process.version,
  checks: {
    pinnedLocalGitOrigin: 'PASS',
    frozenInstallAndBuild: 'PASS',
    tuiVersionAndHelp: 'PASS',
    emptyOfficialSessions: 'PASS',
    doctorNoKeyFailClosed: 'PASS',
    marketplaceHelp: 'PASS',
    remoteHelp: 'PASS',
    failedReinstallPreservesWorkingCLI: 'PASS',
    concurrentInstallFailClosed: 'PASS'
  },
  providerCalls: 0,
  actualAgentTurn: false,
  physicalWsl2Tested: false,
  physicalAndroidTested: false
}
fs.writeFileSync(process.env.EVIDENCE_OUT, JSON.stringify(evidence, null, 2) + '\n')
NODE
fi
echo "FIRST_RUN_PASS source=$SOURCE_SHA node=$(node -p 'process.version')"
echo "Real Linux install & CLI startup verified; no provider calls / real WSL2 hardware claims."
