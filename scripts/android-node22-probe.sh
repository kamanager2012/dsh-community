#!/usr/bin/env bash
set -euo pipefail

# Manual Reality Gate for the Android Node carrier candidate.
#
# This script does NOT download toolchains or source code and is never run by
# ordinary CI. It verifies a caller-supplied Node v22.19.0 source checkout,
# cross-builds it with the official Node Android configure path, and optionally
# executes the resulting carrier on a real Android device through adb.
#
# Usage:
#   NODE_SOURCE_DIR=/abs/node-v22.19.0 \
#   ANDROID_NDK_HOME=/abs/android-ndk-rXX \
#   bash scripts/android-node22-probe.sh build
#
#   NODE_BIN=/abs/node-v22.19.0/out/Release/node \
#   adb devices
#   bash scripts/android-node22-probe.sh device
#
#   # Build and device execution in one pass:
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

verify_source_version() {
  local src="$1"
  local header="$src/src/node_version.h"
  [[ -f "$header" ]] || fail "missing $header"
  grep -Eq '^#define NODE_MAJOR_VERSION 22$' "$header" || fail "source major is not 22"
  grep -Eq '^#define NODE_MINOR_VERSION 19$' "$header" || fail "source minor is not 19"
  grep -Eq '^#define NODE_PATCH_VERSION 0$' "$header" || fail "source patch is not 0"
}

build_carrier() {
  local src="${NODE_SOURCE_DIR:-}"
  local ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
  [[ -n "$src" ]] || fail "NODE_SOURCE_DIR is required for build/verify"
  [[ -n "$ndk" ]] || fail "ANDROID_NDK_HOME or ANDROID_NDK_ROOT is required"
  [[ -x "$src/android-configure" || -f "$src/android-configure.py" ]] || fail "official Android configure entry is missing"

  need python3
  need make
  verify_source_version "$src"

  printf 'android-node22-probe: source=%s node=%s api=%s arch=%s\n' "$src" "$NODE_VERSION" "$ANDROID_API" "$ANDROID_ARCH"
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
  fi
}

device_carrier() {
  local bin="${NODE_BIN:-}"
  if [[ -z "$bin" && -n "${NODE_SOURCE_DIR:-}" ]]; then
    bin="$NODE_SOURCE_DIR/out/Release/node"
  fi
  [[ -n "$bin" && -f "$bin" ]] || fail "NODE_BIN (or NODE_SOURCE_DIR/out/Release/node) is required for device/verify"

  need adb
  local adb=(adb)
  if [[ -n "${ADB_SERIAL:-}" ]]; then
    adb+=( -s "$ADB_SERIAL" )
  fi

  local count
  count="$("${adb[@]}" devices | awk 'NR>1 && $2=="device" {n++} END {print n+0}')"
  [[ "$count" -ge 1 ]] || fail "no authorized Android device visible to adb"
  [[ "$count" -eq 1 || -n "${ADB_SERIAL:-}" ]] || fail "multiple devices; set ADB_SERIAL"

  local remote="/data/local/tmp/dsh-community-node-${NODE_VERSION}"
  "${adb[@]}" push "$bin" "$remote" >/dev/null
  "${adb[@]}" shell chmod 0755 "$remote"
  local observed
  observed="$("${adb[@]}" shell "$remote" -p 'process.versions.node' | tr -d '\r')"
  [[ "$observed" == "$NODE_VERSION" ]] || fail "device reported Node $observed, expected $NODE_VERSION"
  "${adb[@]}" shell "$remote" -e 'if (process.platform !== "android") { throw new Error("platform="+process.platform) }'
  printf 'android-node22-probe: DEVICE_OK node=%s platform=android\n' "$observed"
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
