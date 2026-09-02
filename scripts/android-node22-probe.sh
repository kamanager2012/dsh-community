#!/usr/bin/env bash
set -euo pipefail

# Manual preliminary ADB-shell Reality Gate for the Android Node executable.
#
# This is NOT the APK release carrier gate. It proves only that the exact
# official Node v22.19.0 executable can run in an adb-shell execution world.
# The APK release carrier is the separate official --shared libnode.so candidate
# built by scripts/android-node22-apk-carrier-probe.sh and must be loaded under
# the APK app UID through the native/JNI surface.
#
# This script never downloads source code or toolchains and is not part of
# ordinary CI. It accepts a caller-supplied official Node v22.19.0 git checkout
# plus Android NDK, cross-builds through Node's own Android configure path, and
# executes the resulting shell probe on a real Android device through adb.
#
# Usage:
#   NODE_SOURCE_DIR=/abs/node-v22.19.0 \
#   ANDROID_NDK_HOME=/abs/android-ndk \
#   bash scripts/android-node22-probe.sh build
#
#   NODE_BIN=/abs/node-v22.19.0/out/Release/node \
#   bash scripts/android-node22-probe.sh device
#
#   NODE_SOURCE_DIR=... ANDROID_NDK_HOME=... \
#   bash scripts/android-node22-probe.sh verify
#
# Optional:
#   ANDROID_API=26
#   ANDROID_ARCH=arm64
#   JOBS=4
#   ADB_SERIAL=<serial>

MODE="${1:-verify}"
NODE_VERSION="22.19.0"
NODE_SOURCE_TAG="v22.19.0"
NODE_TAG_OBJECT="a9d4750074c7b5439c61daa28ea9afb5dc28e43e"
NODE_SOURCE_COMMIT="f8fe6858549f75a4b4e9633abf39dd2038dbf496"
ANDROID_API="${ANDROID_API:-26}"
ANDROID_ARCH="${ANDROID_ARCH:-arm64}"
JOBS="${JOBS:-4}"

fail() {
  printf 'android-node22-probe: FAIL: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

verify_source_identity() {
  local src="$1"
  local header="$src/src/node_version.h"

  [[ -f "$header" ]] || fail "missing $header"
  need git
  git -C "$src" rev-parse --is-inside-work-tree >/dev/null 2>&1     || fail "NODE_SOURCE_DIR must be a git checkout"

  local tag_object
  tag_object="$(git -C "$src" rev-parse "refs/tags/$NODE_SOURCE_TAG" 2>/dev/null || true)"
  [[ "$tag_object" == "$NODE_TAG_OBJECT" ]]     || fail "tag object mismatch for $NODE_SOURCE_TAG: got ${tag_object:-missing}"

  local tag_commit
  tag_commit="$(git -C "$src" rev-parse "refs/tags/$NODE_SOURCE_TAG^{commit}" 2>/dev/null || true)"
  [[ "$tag_commit" == "$NODE_SOURCE_COMMIT" ]]     || fail "tag commit mismatch for $NODE_SOURCE_TAG: got ${tag_commit:-missing}"

  local head
  head="$(git -C "$src" rev-parse HEAD)"
  [[ "$head" == "$NODE_SOURCE_COMMIT" ]] || fail "source HEAD mismatch: got $head"

  git -C "$src" diff --quiet || fail "tracked Node source has unstaged changes"
  git -C "$src" diff --cached --quiet || fail "tracked Node source has staged changes"

  grep -Eq '^#define NODE_MAJOR_VERSION 22$' "$header" || fail "source major is not 22"
  grep -Eq '^#define NODE_MINOR_VERSION 19$' "$header" || fail "source minor is not 19"
  grep -Eq '^#define NODE_PATCH_VERSION 0$' "$header" || fail "source patch is not 0"

  printf 'android-node22-probe: SOURCE_OK tag=%s tagObject=%s commit=%s\n'     "$NODE_SOURCE_TAG" "$NODE_TAG_OBJECT" "$NODE_SOURCE_COMMIT"
}

build_carrier() {
  local src="${NODE_SOURCE_DIR:-}"
  local ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"

  [[ -n "$src" ]] || fail "NODE_SOURCE_DIR is required for build/verify"
  [[ -n "$ndk" ]] || fail "ANDROID_NDK_HOME or ANDROID_NDK_ROOT is required"
  [[ -x "$src/android-configure" || -f "$src/android_configure.py" ]]     || fail "official Android configure entry is missing"

  need python3
  need make
  verify_source_identity "$src"

  printf 'android-node22-probe: source=%s node=%s commit=%s api=%s arch=%s\n'     "$src" "$NODE_VERSION" "$NODE_SOURCE_COMMIT" "$ANDROID_API" "$ANDROID_ARCH"

  (
    cd "$src"
    if [[ -x ./android-configure ]]; then
      ./android-configure "$ndk" "$ANDROID_API" "$ANDROID_ARCH"
    else
      python3 ./android_configure.py "$ndk" "$ANDROID_API" "$ANDROID_ARCH"
    fi
    make -j"$JOBS"
  )

  local bin="$src/out/Release/node"
  [[ -x "$bin" ]] || fail "expected carrier not found: $bin"

  printf 'android-node22-probe: BUILD_OK carrier=%s\n' "$bin"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$bin"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$bin"
  else
    fail "sha256sum or shasum is required to record carrier identity"
  fi
}

device_carrier() {
  local bin="${NODE_BIN:-}"
  if [[ -z "$bin" && -n "${NODE_SOURCE_DIR:-}" ]]; then
    bin="$NODE_SOURCE_DIR/out/Release/node"
  fi
  [[ -n "$bin" && -f "$bin" ]]     || fail "NODE_BIN (or NODE_SOURCE_DIR/out/Release/node) is required for device/verify"

  need adb
  local adb=(adb)
  if [[ -n "${ADB_SERIAL:-}" ]]; then
    adb+=( -s "$ADB_SERIAL" )
  fi

  local count
  count="$("${adb[@]}" devices | awk 'NR>1 && $2=="device" {n++} END {print n+0}')"
  [[ "$count" -ge 1 ]] || fail "no authorized Android device visible to adb"
  [[ "$count" -eq 1 || -n "${ADB_SERIAL:-}" ]]     || fail "multiple devices; set ADB_SERIAL"

  local remote="/data/local/tmp/dsh-community-node-${NODE_VERSION}"
  "${adb[@]}" push "$bin" "$remote" >/dev/null
  "${adb[@]}" shell chmod 0755 "$remote"

  local observed
  observed="$("${adb[@]}" shell "$remote" -p 'process.versions.node' | tr -d '\r')"
  [[ "$observed" == "$NODE_VERSION" ]]     || fail "device reported Node $observed, expected $NODE_VERSION"

  "${adb[@]}" shell "$remote" -e     'if (process.platform !== "android") { throw new Error("platform=" + process.platform) }'

  printf 'android-node22-probe: DEVICE_OK node=%s platform=android\n' "$observed"
  printf 'android-node22-probe: EVIDENCE_SCOPE=ADB_SHELL_PRELIMINARY_NOT_APK\n'
  "${adb[@]}" shell rm -f "$remote" >/dev/null 2>&1 || true
}

case "$MODE" in
  build)
    build_carrier
    ;;
  device)
    device_carrier
    ;;
  verify)
    build_carrier
    device_carrier
    ;;
  *)
    fail "usage: $0 [build|device|verify]"
    ;;
esac
