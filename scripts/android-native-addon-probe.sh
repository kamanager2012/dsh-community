#!/usr/bin/env bash
set -euo pipefail

# Manual G2 probe for native packages carried by the frozen official DSH runtime.
#
# This script:
# - downloads nothing;
# - patches/modifies no upstream source file;
# - requires a caller-supplied frozen runtime tree, exact official Node v22.19.0
#   source checkout, Android NDK, and (for device mode) the built Android Node
#   carrier plus adb;
# - builds in a disposable copy so the frozen runtime source tree is untouched.
#
# The build recipes intentionally exercise the unmodified locked packages.
# A build failure is evidence for the next compatibility decision, not something
# this script hides with an implicit patch.
#
# Usage:
#   RUNTIME_DIR=/abs/runtime-stage \
#   NODE_SOURCE_DIR=/abs/node-v22.19.0 \
#   ANDROID_NDK_HOME=/abs/android-ndk \
#   bash scripts/android-native-addon-probe.sh build
#
#   NODE_BIN=/abs/node-v22.19.0/out/Release/node \
#   ANDROID_NATIVE_WORK_ROOT=/abs/work \
#   bash scripts/android-native-addon-probe.sh device
#
# Modes: preflight | build-node-pty | build-koffi | build | device | verify
#
# Optional:
#   ANDROID_API=26
#   ANDROID_ARCH=arm64        # arm64 | x86_64
#   ANDROID_NATIVE_WORK_ROOT=/tmp/dsh-android-native
#   ADB_SERIAL=<serial>

MODE="${1:-preflight}"
EXPECTED_DSH="0.1.2-alpha.4"
EXPECTED_NODE="22.19.0"
EXPECTED_NODE_TAG="v22.19.0"
EXPECTED_NODE_TAG_OBJECT="a9d4750074c7b5439c61daa28ea9afb5dc28e43e"
EXPECTED_NODE_COMMIT="f8fe6858549f75a4b4e9633abf39dd2038dbf496"
EXPECTED_NODE_PTY="1.2.0-beta.15"
EXPECTED_KOFFI="3.1.6"
EXPECTED_SHARP="0.35.4"
EXPECTED_SHARP_WASM="0.35.4"
EXPECTED_EMNAPI="1.11.3"

ANDROID_API="${ANDROID_API:-26}"
ANDROID_ARCH="${ANDROID_ARCH:-arm64}"
WORK_ROOT="${ANDROID_NATIVE_WORK_ROOT:-${TMPDIR:-/tmp}/dsh-android-native}"

fail() {
  printf 'android-native-addon-probe: FAIL: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

json_value() {
  local file="$1"
  local expression="$2"
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const path = process.argv[2].split(".");
    let current = value;
    for (const key of path) current = current?.[key];
    if (current === undefined) process.exit(2);
    process.stdout.write(String(current));
  ' "$file" "$expression"
}

host_os_for_gyp() {
  case "$(uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'darwin' ;;
    *) fail "build host must be Linux or Darwin" ;;
  esac
}

configure_arch() {
  case "$ANDROID_ARCH" in
    arm64)
      ANDROID_ABI="arm64-v8a"
      NODE_GYP_ARCH="arm64"
      NODE_DEST_CPU="arm64"
      NDK_TRIPLET="aarch64-linux-android"
      ;;
    x86_64)
      ANDROID_ABI="x86_64"
      NODE_GYP_ARCH="x64"
      NODE_DEST_CPU="x64"
      NDK_TRIPLET="x86_64-linux-android"
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
    *) fail "unsupported build host" ;;
  esac
  local bin="$ndk/toolchains/llvm/prebuilt/$prebuilt/bin"
  [[ -d "$bin" ]] || fail "Android NDK LLVM toolchain missing: $bin"
  printf '%s' "$bin"
}

verify_node_source() {
  local src="$1"
  [[ -f "$src/src/node_version.h" ]] || fail "missing Node source header"
  [[ -f "$src/config.gypi" ]] || fail "Node source has not been configured for the Android carrier (config.gypi missing)"
  [[ -f "$src/out/Release/node" ]] || fail "Node Android carrier has not been built (out/Release/node missing)"
  need git

  local tag_object
  tag_object="$(git -C "$src" rev-parse "refs/tags/$EXPECTED_NODE_TAG" 2>/dev/null || true)"
  [[ "$tag_object" == "$EXPECTED_NODE_TAG_OBJECT" ]]     || fail "Node tag object mismatch: ${tag_object:-missing}"

  local tag_commit
  tag_commit="$(git -C "$src" rev-parse "refs/tags/$EXPECTED_NODE_TAG^{commit}" 2>/dev/null || true)"
  [[ "$tag_commit" == "$EXPECTED_NODE_COMMIT" ]]     || fail "Node tag commit mismatch: ${tag_commit:-missing}"

  local head
  head="$(git -C "$src" rev-parse HEAD)"
  [[ "$head" == "$EXPECTED_NODE_COMMIT" ]] || fail "Node HEAD mismatch: $head"

  git -C "$src" diff --quiet || fail "Node source has unstaged tracked changes"
  git -C "$src" diff --cached --quiet || fail "Node source has staged tracked changes"

  grep -Eq '^#define NODE_MAJOR_VERSION 22$' "$src/src/node_version.h"     || fail "Node source major mismatch"
  grep -Eq '^#define NODE_MINOR_VERSION 19$' "$src/src/node_version.h"     || fail "Node source minor mismatch"
  grep -Eq '^#define NODE_PATCH_VERSION 0$' "$src/src/node_version.h"     || fail "Node source patch mismatch"
}

verify_runtime() {
  local runtime="$1"
  [[ -d "$runtime/node_modules" ]] || fail "RUNTIME_DIR must contain node_modules"

  local dsh="$runtime/node_modules/@deepseek-ai/dsh/package.json"
  local pty="$runtime/node_modules/node-pty/package.json"
  local koffi="$runtime/node_modules/koffi/package.json"

  [[ -f "$dsh" && -f "$pty" && -f "$koffi" ]]     || fail "runtime is missing DSH/node-pty/koffi package manifests"

  [[ "$(json_value "$dsh" version)" == "$EXPECTED_DSH" ]]     || fail "runtime DSH version mismatch"
  [[ "$(json_value "$pty" version)" == "$EXPECTED_NODE_PTY" ]]     || fail "runtime node-pty version mismatch"
  [[ "$(json_value "$koffi" version)" == "$EXPECTED_KOFFI" ]]     || fail "runtime Koffi version mismatch"

  [[ -f "$runtime/node_modules/node-pty/binding.gyp" ]]     || fail "node-pty source is missing from runtime"
  [[ -f "$runtime/node_modules/koffi/src/koffi/CMakeLists.txt" ]]     || fail "Koffi CMake source is missing from runtime"
  [[ -f "$runtime/node_modules/koffi/vendor/node-api-headers/include/node_api.h" ]]     || fail "Koffi vendored Node-API headers are missing"
}

preflight() {
  local runtime="${RUNTIME_DIR:-}"
  local src="${NODE_SOURCE_DIR:-}"
  local ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"

  [[ -n "$runtime" ]] || fail "RUNTIME_DIR is required"
  [[ -n "$src" ]] || fail "NODE_SOURCE_DIR is required"
  [[ -n "$ndk" ]] || fail "ANDROID_NDK_HOME or ANDROID_NDK_ROOT is required"

  need node
  need npm
  need cmake
  need git
  need cp
  need find
  [[ "$ANDROID_API" =~ ^[0-9]+$ ]] || fail "ANDROID_API must be an integer"
  (( ANDROID_API >= 24 )) || fail "official Node Android builds require API 24 or newer"
  configure_arch
  verify_node_source "$src"
  verify_runtime "$runtime"

  local toolbin
  toolbin="$(ndk_toolchain_bin "$ndk")"
  [[ -x "$toolbin/${NDK_TRIPLET}${ANDROID_API}-clang" ]]     || fail "NDK C compiler missing for API $ANDROID_API"
  [[ -x "$toolbin/${NDK_TRIPLET}${ANDROID_API}-clang++" ]]     || fail "NDK C++ compiler missing for API $ANDROID_API"
  [[ -f "$ndk/build/cmake/android.toolchain.cmake" ]]     || fail "NDK CMake toolchain file missing"

  printf 'android-native-addon-probe: PREFLIGHT_OK dsh=%s node=%s arch=%s api=%s\n'     "$EXPECTED_DSH" "$EXPECTED_NODE" "$ANDROID_ARCH" "$ANDROID_API"
}

prepare_work_runtime() {
  local runtime="$1"
  rm -rf "$WORK_ROOT/runtime"
  mkdir -p "$WORK_ROOT"
  cp -a "$runtime" "$WORK_ROOT/runtime"
}

build_node_pty() {
  preflight
  local runtime="$RUNTIME_DIR"
  local src="$NODE_SOURCE_DIR"
  local ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
  prepare_work_runtime "$runtime"

  configure_arch
  local toolbin
  toolbin="$(ndk_toolchain_bin "$ndk")"
  local host_os
  host_os="$(host_os_for_gyp)"

  local target="$WORK_ROOT/runtime/node_modules/node-pty"
  rm -rf "$target/build" "$target/prebuilds"

  export CC="$toolbin/${NDK_TRIPLET}${ANDROID_API}-clang"
  export CXX="$toolbin/${NDK_TRIPLET}${ANDROID_API}-clang++"
  export AR="$toolbin/llvm-ar"
  export LD="$toolbin/ld.lld"
  export npm_config_nodedir="$src"
  export npm_config_arch="$NODE_GYP_ARCH"
  export npm_config_platform="android"
  export npm_config_build_from_source="true"
  export GYP_DEFINES="target_arch=$NODE_GYP_ARCH v8_target_arch=$NODE_GYP_ARCH android_target_arch=$NODE_GYP_ARCH host_os=$host_os OS=android android_ndk_path=$ndk"

  (
    cd "$WORK_ROOT/runtime"
    npm rebuild node-pty --build-from-source --no-audit --no-fund
  )

  local binary="$target/build/Release/pty.node"
  [[ -f "$binary" ]] || fail "node-pty build completed without $binary"
  printf 'android-native-addon-probe: NODE_PTY_BUILD_OK binary=%s\n' "$binary"
  checksum "$binary"
}

write_find_cnoke() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/FindCNoke.cmake" <<'CMAKE'
function(add_node_addon)
  cmake_parse_arguments(ARG "" "NAME" "SOURCES" ${ARGN})
  add_library(${ARG_NAME} SHARED ${ARG_SOURCES})
  set_target_properties(${ARG_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
  target_include_directories(${ARG_NAME} PRIVATE ${NODE_JS_INCLUDE_DIRS})
  if(NODE_JS_LINK_FLAGS)
    target_link_options(${ARG_NAME} PRIVATE ${NODE_JS_LINK_FLAGS})
  endif()
endfunction()

function(target_link_node TARGET)
  target_include_directories(${TARGET} PRIVATE ${NODE_JS_INCLUDE_DIRS})
  if(NODE_JS_LINK_FLAGS)
    target_link_options(${TARGET} PRIVATE ${NODE_JS_LINK_FLAGS})
  endif()
endfunction()
CMAKE
}

build_koffi() {
  preflight
  local runtime="$RUNTIME_DIR"
  local ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"

  if [[ ! -d "$WORK_ROOT/runtime" ]]; then
    prepare_work_runtime "$runtime"
  fi

  configure_arch
  local pkg="$WORK_ROOT/runtime/node_modules/koffi"
  local project="$pkg/src/koffi"
  local build="$WORK_ROOT/koffi-build"
  local modules="$WORK_ROOT/koffi-cmake"
  rm -rf "$build" "$modules"
  write_find_cnoke "$modules"

  cmake -S "$project" -B "$build"     -DCMAKE_TOOLCHAIN_FILE="$ndk/build/cmake/android.toolchain.cmake"     -DANDROID_ABI="$ANDROID_ABI"     -DANDROID_PLATFORM="android-$ANDROID_API"     -DANDROID_STL="c++_static"     -DCMAKE_BUILD_TYPE=Release     -DCMAKE_MODULE_PATH="$modules"     -DNODE_JS_EXECPATH="$(command -v node)"     -DNODE_JS_INCLUDE_DIRS="$pkg/vendor/node-api-headers/include"

  cmake --build "$build" --config Release --target koffi

  local binary
  binary="$(find "$build" -type f -name 'koffi.node' -print -quit)"
  [[ -n "$binary" && -f "$binary" ]] || fail "Koffi build completed without koffi.node"
  mkdir -p "$WORK_ROOT/artifacts"
  cp "$binary" "$WORK_ROOT/artifacts/koffi.node"
  printf 'android-native-addon-probe: KOFFI_BUILD_OK binary=%s\n' "$WORK_ROOT/artifacts/koffi.node"
  checksum "$WORK_ROOT/artifacts/koffi.node"
}

prepare_sharp_smoke_tree() {
  local runtime="$WORK_ROOT/runtime"
  [[ -d "$runtime/node_modules" ]] || fail "built runtime work tree is missing for sharp device smoke"

  local packages=(
    "sharp"
    "@img/sharp-wasm32"
    "@emnapi/runtime"
    "@img/colour"
    "detect-libc"
    "semver"
    "tslib"
  )

  rm -rf "$WORK_ROOT/sharp-smoke"
  for package in "${packages[@]}"; do
    local src="$runtime/node_modules/$package"
    [[ -d "$src" ]] || fail "sharp WASM materialization gap: missing $package in frozen runtime staging"
    local dest="$WORK_ROOT/sharp-smoke/node_modules/$package"
    mkdir -p "$(dirname "$dest")"
    cp -a "$src" "$dest"
  done

  [[ "$(json_value "$WORK_ROOT/sharp-smoke/node_modules/sharp/package.json" version)" == "$EXPECTED_SHARP" ]]     || fail "sharp version mismatch in device smoke tree"
  [[ "$(json_value "$WORK_ROOT/sharp-smoke/node_modules/@img/sharp-wasm32/package.json" version)" == "$EXPECTED_SHARP_WASM" ]]     || fail "sharp-wasm32 version mismatch in device smoke tree"
  [[ "$(json_value "$WORK_ROOT/sharp-smoke/node_modules/@emnapi/runtime/package.json" version)" == "$EXPECTED_EMNAPI" ]]     || fail "emnapi version mismatch in device smoke tree"

  printf 'android-native-addon-probe: SHARP_WASM_MATERIALIZED version=%s\n' "$EXPECTED_SHARP_WASM"
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

device_probe() {
  local node_bin="${NODE_BIN:-}"
  if [[ -z "$node_bin" && -n "${NODE_SOURCE_DIR:-}" ]]; then
    node_bin="$NODE_SOURCE_DIR/out/Release/node"
  fi
  [[ -n "$node_bin" && -f "$node_bin" ]] || fail "NODE_BIN (or NODE_SOURCE_DIR/out/Release/node) is required for device mode"
  [[ -d "$WORK_ROOT/runtime/node_modules/node-pty" ]]     || fail "built node-pty package is missing under ANDROID_NATIVE_WORK_ROOT"
  [[ -f "$WORK_ROOT/artifacts/koffi.node" ]]     || fail "built Koffi addon is missing under ANDROID_NATIVE_WORK_ROOT"
  prepare_sharp_smoke_tree

  require_one_device
  local adb=(adb)
  if [[ -n "${ADB_SERIAL:-}" ]]; then adb+=( -s "$ADB_SERIAL" ); fi

  local remote="/data/local/tmp/dsh-community-native-probe"
  "${adb[@]}" shell rm -rf "$remote"
  "${adb[@]}" shell mkdir -p "$remote"
  "${adb[@]}" push "$node_bin" "$remote/node" >/dev/null
  "${adb[@]}" push "$WORK_ROOT/runtime/node_modules/node-pty" "$remote/node-pty" >/dev/null
  "${adb[@]}" push "$WORK_ROOT/artifacts/koffi.node" "$remote/koffi.node" >/dev/null
  "${adb[@]}" push "$WORK_ROOT/sharp-smoke/node_modules" "$remote/node_modules" >/dev/null
  "${adb[@]}" shell chmod 0755 "$remote/node"

  local observed
  observed="$("${adb[@]}" shell "$remote/node" -p 'process.versions.node + ":" + process.platform + ":" + process.arch' | tr -d '\r')"
  case "$ANDROID_ARCH" in
    arm64) [[ "$observed" == "$EXPECTED_NODE:android:arm64" ]] || fail "unexpected carrier identity: $observed" ;;
    x86_64) [[ "$observed" == "$EXPECTED_NODE:android:x64" ]] || fail "unexpected carrier identity: $observed" ;;
  esac

  "${adb[@]}" shell "$remote/node" -e '
    const koffi = require(process.argv[1]);
    const getpid = koffi.load(null).func("int getpid(void)");
    const pid = getpid();
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("invalid getpid result");
    process.stdout.write("KOFFI_DEVICE_OK pid=" + pid + "\n");
  ' "$remote/koffi.node"

  "${adb[@]}" shell "$remote/node" -e '
    (async () => {
      const sharp = require(process.argv[1]);
      const png = await sharp({
        create: {
          width: 2,
          height: 2,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      }).png().toBuffer();
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (png.length <= signature.length || !png.subarray(0, signature.length).equals(signature)) {
        throw new Error("sharp PNG smoke produced invalid output");
      }
      process.stdout.write("SHARP_WASM_DEVICE_OK bytes=" + png.length + "\n");
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  ' "$remote/node_modules/sharp"

  "${adb[@]}" shell "$remote/node" -e '
    const pty = require(process.argv[1]);
    const child = pty.spawn("/system/bin/sh", ["-c", "printf DSH_PTY_OK"], {
      name: "dumb",
      cols: 80,
      rows: 24,
      cwd: "/data/local/tmp",
      env: { PATH: "/system/bin" },
    });
    let output = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      throw new Error("PTY smoke timed out");
    }, 5000);
    child.onData(data => { output += data; });
    child.onExit(() => {
      clearTimeout(timer);
      if (!output.includes("DSH_PTY_OK")) throw new Error("PTY output mismatch: " + JSON.stringify(output));
      process.stdout.write("NODE_PTY_DEVICE_OK\n");
    });
  ' "$remote/node-pty"

  "${adb[@]}" shell rm -rf "$remote" >/dev/null 2>&1 || true
  printf 'android-native-addon-probe: DEVICE_OK node=%s arch=%s\n' "$EXPECTED_NODE" "$ANDROID_ARCH"
}

case "$MODE" in
  preflight)
    preflight
    ;;
  build-node-pty)
    build_node_pty
    ;;
  build-koffi)
    build_koffi
    ;;
  build)
    build_node_pty
    build_koffi
    ;;
  device)
    configure_arch
    device_probe
    ;;
  verify)
    build_node_pty
    build_koffi
    device_probe
    ;;
  *)
    fail "usage: $0 [preflight|build-node-pty|build-koffi|build|device|verify]"
    ;;
esac
