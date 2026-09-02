#!/usr/bin/env bash
set -euo pipefail

# Manual build gate for the APK-embedded Node carrier candidate.
#
# This is intentionally separate from android-node22-probe.sh:
# - android-node22-probe.sh proves an Android Node executable under adb shell.
# - this script builds Node's official --shared embedding form (libnode.so)
#   for code that must be packaged inside the APK/native-library surface.
#
# The script downloads nothing and patches no Node source.
#
# Usage:
#   NODE_SOURCE_DIR=/abs/node-v22.19.0 \
#   ANDROID_NDK_HOME=/abs/android-ndk \
#   bash scripts/android-node22-apk-carrier-probe.sh build
#
# Optional:
#   ANDROID_API=26
#   ANDROID_ARCH=arm64       # arm64 | x86_64
#   JOBS=4

MODE="${1:-preflight}"
NODE_VERSION="22.19.0"
NODE_SOURCE_TAG="v22.19.0"
NODE_TAG_OBJECT="a9d4750074c7b5439c61daa28ea9afb5dc28e43e"
NODE_SOURCE_COMMIT="f8fe6858549f75a4b4e9633abf39dd2038dbf496"
ANDROID_API="${ANDROID_API:-26}"
ANDROID_ARCH="${ANDROID_ARCH:-arm64}"
JOBS="${JOBS:-4}"

fail() {
  printf 'android-node22-apk-carrier-probe: FAIL: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

configure_arch() {
  case "$ANDROID_ARCH" in
    arm64)
      DEST_CPU="arm64"
      GYP_ARCH="arm64"
      TOOLCHAIN_PREFIX="aarch64-linux-android"
      ANDROID_ABI="arm64-v8a"
      ;;
    x86_64)
      DEST_CPU="x64"
      GYP_ARCH="x64"
      TOOLCHAIN_PREFIX="x86_64-linux-android"
      ANDROID_ABI="x86_64"
      ;;
    *)
      fail "ANDROID_ARCH must be arm64 or x86_64"
      ;;
  esac
}

toolchain_bin() {
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
  local dir="$ndk/toolchains/llvm/prebuilt/$prebuilt/bin"
  [[ -d "$dir" ]] || fail "Android NDK LLVM toolchain missing: $dir"
  printf '%s' "$dir"
}

verify_source_identity() {
  local src="$1"
  [[ -f "$src/src/node_version.h" ]] || fail "missing Node source header"
  [[ -x "$src/configure" ]] || fail "official Node configure entry is missing"
  need git

  local tag_object
  tag_object="$(git -C "$src" rev-parse "refs/tags/$NODE_SOURCE_TAG" 2>/dev/null || true)"
  [[ "$tag_object" == "$NODE_TAG_OBJECT" ]]     || fail "Node tag object mismatch: ${tag_object:-missing}"

  local tag_commit
  tag_commit="$(git -C "$src" rev-parse "refs/tags/$NODE_SOURCE_TAG^{commit}" 2>/dev/null || true)"
  [[ "$tag_commit" == "$NODE_SOURCE_COMMIT" ]]     || fail "Node tag commit mismatch: ${tag_commit:-missing}"

  local head
  head="$(git -C "$src" rev-parse HEAD)"
  [[ "$head" == "$NODE_SOURCE_COMMIT" ]] || fail "Node HEAD mismatch: $head"

  git -C "$src" diff --quiet || fail "Node source has unstaged tracked changes"
  git -C "$src" diff --cached --quiet || fail "Node source has staged tracked changes"

  grep -Eq '^#define NODE_MAJOR_VERSION 22$' "$src/src/node_version.h" || fail "Node major mismatch"
  grep -Eq '^#define NODE_MINOR_VERSION 19$' "$src/src/node_version.h" || fail "Node minor mismatch"
  grep -Eq '^#define NODE_PATCH_VERSION 0$' "$src/src/node_version.h" || fail "Node patch mismatch"
}

preflight() {
  local src="${NODE_SOURCE_DIR:-}"
  local ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"

  [[ -n "$src" ]] || fail "NODE_SOURCE_DIR is required"
  [[ -n "$ndk" ]] || fail "ANDROID_NDK_HOME or ANDROID_NDK_ROOT is required"
  [[ "$ANDROID_API" =~ ^[0-9]+$ ]] || fail "ANDROID_API must be an integer"
  (( ANDROID_API >= 24 )) || fail "official Node Android builds require API 24 or newer"
  [[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || fail "JOBS must be a positive integer"

  need python3
  need make
  configure_arch
  verify_source_identity "$src"
  [[ ! -e "$src/config.gypi" ]]     || fail "shared-carrier probe requires a fresh Node checkout/build tree (config.gypi already exists)"
  [[ ! -e "$src/out" ]]     || fail "shared-carrier probe requires a fresh Node checkout/build tree (out/ already exists)"

  local bin
  bin="$(toolchain_bin "$ndk")"
  [[ -x "$bin/${TOOLCHAIN_PREFIX}${ANDROID_API}-clang" ]] || fail "NDK C compiler missing"
  [[ -x "$bin/${TOOLCHAIN_PREFIX}${ANDROID_API}-clang++" ]] || fail "NDK C++ compiler missing"
  [[ -x "$bin/llvm-readelf" ]] || fail "NDK llvm-readelf missing"

  printf 'android-node22-apk-carrier-probe: PREFLIGHT_OK node=%s commit=%s abi=%s api=%s\n'     "$NODE_VERSION" "$NODE_SOURCE_COMMIT" "$ANDROID_ABI" "$ANDROID_API"
}

build_shared() {
  preflight
  local src="$NODE_SOURCE_DIR"
  local ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
  local bin
  bin="$(toolchain_bin "$ndk")"
  local host_os
  case "$(uname -s)" in
    Linux) host_os="linux" ;;
    Darwin) host_os="darwin" ;;
  esac

  export PATH="$PATH:$bin"
  export CC="$bin/${TOOLCHAIN_PREFIX}${ANDROID_API}-clang"
  export CXX="$bin/${TOOLCHAIN_PREFIX}${ANDROID_API}-clang++"
  export GYP_DEFINES="target_arch=$GYP_ARCH v8_target_arch=$GYP_ARCH android_target_arch=$GYP_ARCH host_os=$host_os OS=android android_ndk_path=$ndk"

  (
    cd "$src"
    ./configure       --dest-cpu="$DEST_CPU"       --dest-os=android       --openssl-no-asm       --cross-compiling       --shared
    make -j"$JOBS"
  )

  local lib="$src/out/Release/lib.target/libnode.so"
  [[ -f "$lib" ]] || fail "shared build completed without $lib"

  local header
  header="$("$bin/llvm-readelf" -h "$lib")"
  grep -Eq 'Type:[[:space:]]+DYN' <<<"$header"     || fail "libnode.so is not an ELF shared object"

  printf 'android-node22-apk-carrier-probe: APK_SHARED_BUILD_OK node=%s abi=%s artifact=%s\n'     "$NODE_VERSION" "$ANDROID_ABI" "$lib"
  checksum "$lib"
  printf 'android-node22-apk-carrier-probe: NEXT_REQUIRED=APK_JNI_APP_UID_LOAD\n'
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

case "$MODE" in
  preflight) preflight ;;
  build) build_shared ;;
  *) fail "usage: $0 [preflight|build]" ;;
esac
