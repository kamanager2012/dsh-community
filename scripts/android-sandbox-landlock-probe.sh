#!/usr/bin/env bash
set -euo pipefail

# G2 sandbox substrate probe.
#
# Builds the unmodified C source shipped inside the frozen
# @deepseek-ai/node-addon-landlock-run@0.1.1 npm package with the Android NDK.
# No network access, no upstream patching, no second source checkout.
#
# Device mode runs under adb shell ONLY and is preliminary kernel evidence.
# It is deliberately not app-UID / APK acceptance evidence.
#
# Usage:
#   RUNTIME_DIR=/abs/runtime-stage \
#   ANDROID_NDK_HOME=/abs/android-ndk \
#   bash scripts/android-sandbox-landlock-probe.sh build
#
#   LANDLOCK_BIN=/tmp/dsh-android-sandbox/landlock-run \
#   bash scripts/android-sandbox-landlock-probe.sh device
#
# Modes: preflight | build | device | verify

MODE="${1:-preflight}"
EXPECTED_PACKAGE="@deepseek-ai/node-addon-landlock-run"
EXPECTED_VERSION="0.1.1"
ANDROID_API="${ANDROID_API:-26}"
ANDROID_ARCH="${ANDROID_ARCH:-arm64}"
WORK_ROOT="${ANDROID_SANDBOX_WORK_ROOT:-${TMPDIR:-/tmp}/dsh-android-sandbox}"

fail() {
  printf 'android-sandbox-landlock-probe: FAIL: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

json_version() {
  node -e '
    const fs = require("node:fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(pkg.version ?? ""));
  ' "$1"
}

configure_arch() {
  case "$ANDROID_ARCH" in
    arm64)
      NDK_TRIPLET="aarch64-linux-android"
      EXPECTED_DEVICE_ARCH="arm64"
      ;;
    x86_64)
      NDK_TRIPLET="x86_64-linux-android"
      EXPECTED_DEVICE_ARCH="x86_64"
      ;;
    *)
      fail "ANDROID_ARCH must be arm64 or x86_64"
      ;;
  esac
}

ndk_toolchain_bin() {
  local ndk="$1"
  local prebuilt
  case "$(uname -s)" in
    Linux) prebuilt="linux-x86_64" ;;
    Darwin)
      if [[ "$(uname -m)" == "arm64" && -d "$ndk/toolchains/llvm/prebuilt/darwin-arm64" ]]; then
        prebuilt="darwin-arm64"
      else
        prebuilt="darwin-x86_64"
      fi
      ;;
    *) fail "build host must be Linux or Darwin" ;;
  esac
  local bin="$ndk/toolchains/llvm/prebuilt/$prebuilt/bin"
  [[ -d "$bin" ]] || fail "Android NDK LLVM toolchain missing: $bin"
  printf '%s' "$bin"
}

preflight() {
  local runtime="${RUNTIME_DIR:-}"
  local ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"

  [[ -n "$runtime" ]] || fail "RUNTIME_DIR is required"
  [[ -n "$ndk" ]] || fail "ANDROID_NDK_HOME or ANDROID_NDK_ROOT is required"
  [[ "$ANDROID_API" =~ ^[0-9]+$ ]] || fail "ANDROID_API must be an integer"
  (( ANDROID_API >= 24 )) || fail "Android sandbox probe requires API 24 or newer"

  need node
  need cp
  configure_arch

  local pkg="$runtime/node_modules/@deepseek-ai/node-addon-landlock-run"
  [[ -f "$pkg/package.json" ]] || fail "frozen runtime is missing $EXPECTED_PACKAGE"
  [[ "$(json_version "$pkg/package.json")" == "$EXPECTED_VERSION" ]]     || fail "$EXPECTED_PACKAGE version mismatch"
  [[ -f "$pkg/src/main.c" ]]     || fail "$EXPECTED_PACKAGE npm payload is missing src/main.c"

  local toolbin
  toolbin="$(ndk_toolchain_bin "$ndk")"
  [[ -x "$toolbin/${NDK_TRIPLET}${ANDROID_API}-clang" ]]     || fail "NDK C compiler missing for $ANDROID_ARCH API $ANDROID_API"

  printf 'android-sandbox-landlock-probe: PREFLIGHT_OK package=%s@%s arch=%s api=%s\n'     "$EXPECTED_PACKAGE" "$EXPECTED_VERSION" "$ANDROID_ARCH" "$ANDROID_API"
}

build() {
  preflight
  local runtime="$RUNTIME_DIR"
  local ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
  local source="$runtime/node_modules/@deepseek-ai/node-addon-landlock-run/src/main.c"
  local toolbin
  toolbin="$(ndk_toolchain_bin "$ndk")"
  local cc="$toolbin/${NDK_TRIPLET}${ANDROID_API}-clang"

  rm -rf "$WORK_ROOT"
  mkdir -p "$WORK_ROOT"
  "$cc"     -std=c11 -Os -Wall -Wextra -Werror     -fPIE -pie -s     -o "$WORK_ROOT/landlock-run"     "$source"

  [[ -x "$WORK_ROOT/landlock-run" ]] || chmod 0755 "$WORK_ROOT/landlock-run"
  printf 'android-sandbox-landlock-probe: BUILD_OK binary=%s\n' "$WORK_ROOT/landlock-run"
  checksum "$WORK_ROOT/landlock-run"
}

checksum() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file"
  else
    fail "sha256sum or shasum is required"
  fi
}

require_one_device() {
  need adb
  local adb=(adb)
  if [[ -n "${ADB_SERIAL:-}" ]]; then adb+=( -s "$ADB_SERIAL" ); fi
  local count
  count="$("${adb[@]}" devices 2>/dev/null | awk 'NR>1 && $2=="device" {n++} END {print n+0}')"
  [[ "$count" -ge 1 ]] || fail "no authorized Android device visible to adb"
  [[ "$count" -eq 1 || -n "${ADB_SERIAL:-}" ]] || fail "multiple devices; set ADB_SERIAL"
}

device() {
  configure_arch
  local binary="${LANDLOCK_BIN:-$WORK_ROOT/landlock-run}"
  [[ -f "$binary" ]] || fail "LANDLOCK_BIN/build output is missing"

  require_one_device
  local adb=(adb)
  if [[ -n "${ADB_SERIAL:-}" ]]; then adb+=( -s "$ADB_SERIAL" ); fi

  local remote="/data/local/tmp/dsh-community-landlock-probe"
  "${adb[@]}" shell rm -rf "$remote"
  "${adb[@]}" shell mkdir -p "$remote/workspace"
  "${adb[@]}" push "$binary" "$remote/landlock-run" >/dev/null
  "${adb[@]}" shell chmod 0755 "$remote/landlock-run"

  local device_arch
  device_arch="$("${adb[@]}" shell getprop ro.product.cpu.abi | tr -d '\r')"
  case "$ANDROID_ARCH" in
    arm64) [[ "$device_arch" == arm64-v8a* ]] || fail "device ABI $device_arch does not match arm64 probe" ;;
    x86_64) [[ "$device_arch" == x86_64* ]] || fail "device ABI $device_arch does not match x86_64 probe" ;;
  esac

  local probe
  probe="$("${adb[@]}" shell "$remote/landlock-run" --probe | tr -d '\r')"
  [[ "$probe" == "landlock: fully enforced" ]]     || fail "Android provider requires full Landlock enforcement; observed: $probe"

  "${adb[@]}" shell "$remote/landlock-run"     --ro / --rw /dev/null --rw "$remote/workspace" --     /system/bin/sh -c "printf DSH_LANDLOCK_OK > '$remote/workspace/allowed.txt'"
  [[ "$("${adb[@]}" shell cat "$remote/workspace/allowed.txt" | tr -d '\r')" == "DSH_LANDLOCK_OK" ]]     || fail "workspace-write grant did not permit the workspace"

  "${adb[@]}" shell rm -f "$remote/denied.txt"
  if "${adb[@]}" shell "$remote/landlock-run"       --ro / --rw /dev/null --rw "$remote/workspace" --       /system/bin/sh -c "printf SHOULD_NOT_EXIST > '$remote/denied.txt'" >/dev/null 2>&1; then
    fail "Landlock unexpectedly allowed a write outside the granted workspace"
  fi
  if "${adb[@]}" shell test -e "$remote/denied.txt"; then
    fail "denied write created an outside file"
  fi

  "${adb[@]}" shell rm -rf "$remote" >/dev/null 2>&1 || true
  printf 'android-sandbox-landlock-probe: ADB_SHELL_FULL_OK_NOT_APP_UID_ACCEPTANCE arch=%s\n'     "$EXPECTED_DEVICE_ARCH"
}

case "$MODE" in
  preflight) preflight ;;
  build) build ;;
  device) device ;;
  verify)
    build
    device
    ;;
  *) fail "usage: $0 [preflight|build|device|verify]" ;;
esac
