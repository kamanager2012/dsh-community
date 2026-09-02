# Android Fifth Community Endpoint (Mobile)

> Status: `[UNVERIFIED]`. On 2026-09-02 the existing Android source was restored
> from archived Labs into the active `apps/android` tree. No published Android capability is claimed before its Reality Gate passes.

[中文](android-endpoint.md) · [Runtime Substrate](android-runtime-substrate.en.md) · [Reality Gate](reality-gate.en.md)

## Positioning

Android is the **fifth Community endpoint** (after WSL/Linux Terminal, Windows Desktop,
macOS Desktop, and Linux AppImage). Its source is active in this repository, but it is not yet part of Published Latest. The target
shape remains an APK with a WebView shell plus a compatible local Node substrate hosting the official `@deepseek-ai/dsh` runtime. The runtime substrate is currently `BLOCKED`; no Agent loop is reimplemented and no unproven embedded runtime is presented as working.

## Architecture

```text
APK
├── WebView            ← active source; can render the runtime-gate state
├── Node substrate     ← BLOCKED; shell probe and APK shared carrier are separate gates
├── Foreground Service ← fails loud while the gate is closed
└── verification chain ← runtime-substrate.json + Reality Gate
```

## Known risks (facts as of 2026-08-17)

| Item | Fact | Handling |
| --- | --- | --- |
| Node engine | official requires `^22.19.0 \|\| >=24.0.0`; as observed on 2026-09-02, the latest stock nodejs-mobile Android release is Node 18.20.4 | **Hard blocker**: stock nodejs-mobile cannot be treated as a compatible substrate; first prove a Node 22.19+ Android runtime |
| `sharp` | the frozen lock contains exact `@img/sharp-wasm32@0.35.4`, but optional-byte materialization and Android PNG smoke remain unproven | keep official capability ownership; validate through the G2 materialization + device probe |
| Gradle integration | restored Labs source declared `com.github.nodejs-mobile`, but no verified current integration evidence exists | removed from the active Gradle configuration rather than claiming a working Node 22 integration |
| Background keep-alive | OS kills background processes | Foreground Service + persistent notification (also serves as approval entry) |
| Distribution channel | Play Store scrutiny of "runs arbitrary plugin code" | GitHub Releases direct APK + digest, not Play |

## Reality Gate gates (Android specific)

```text
exact Node 22.19.0 source identity
  → G1-Shell: adb-shell executable probe (preliminary / non-release)
  → G1-APK-Build: official Node --shared → libnode.so
  → G1-APK-AppUID: APK native/JNI load under the app UID
  → G2 native / PTY / sandbox / hard-link / sharp / fs-search gates
  → official @deepseek-ai/dsh@0.1.2-alpha.4 Web boot on loopback
  → arm64 real-device + x86_64 emulator APK smoke
  → evidence-backed release
```

Stay `[UNVERIFIED]` until all gates pass. adb-shell or Termux results are preliminary only and cannot substitute for APK app-UID/JNI carrier, sandbox, hard-link, or PTY evidence.

## Verification entry

```bash
# preliminary shell carrier
NODE_SOURCE_DIR=/abs/node-v22.19.0 ANDROID_NDK_HOME=/abs/android-ndk \
  bash scripts/android-node22-probe.sh verify

# APK shared carrier build candidate
NODE_SOURCE_DIR=/abs/node-v22.19.0 ANDROID_NDK_HOME=/abs/android-ndk \
  bash scripts/android-node22-apk-carrier-probe.sh build

# release remains fail-closed until APK app-UID/JNI + downstream records exist
node scripts/verify-android-release-ready.mjs
```

## Machine state

See [`apps/android/runtime-substrate.json`](../apps/android/runtime-substrate.json) and [`apps/android/carrier-packaging.json`](../apps/android/carrier-packaging.json). Android must not be described as a runnable APK until the shared carrier, app-UID/JNI load, and every downstream Reality Gate are backed by real evidence.
