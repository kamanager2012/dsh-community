# Android Fifth Community Endpoint (Mobile)

> Status: `[UNVERIFIED]`. On 2026-09-02 the existing Android source was restored
> from archived Labs into the active `apps/android` tree. No published Android capability is claimed before its Reality Gate passes.

[中文](android-endpoint.md) · [Reality Gate](reality-gate.en.md)

## Positioning

Android is the **fifth Community endpoint** (after WSL/Linux Terminal, Windows Desktop,
macOS Desktop, and Linux AppImage). Its source is active in this repository, but it is not yet part of Published Latest. The target
shape remains an APK with a WebView shell plus a compatible local Node substrate hosting the official `@deepseek-ai/dsh` runtime. The runtime substrate is currently `BLOCKED`; no Agent loop is reimplemented and no unproven embedded runtime is presented as working.

## Architecture

```text
APK
├── WebView            ← active source; can render the runtime-gate state
├── Node substrate     ← BLOCKED until a Node 22.19+ Android runtime is proven
├── Foreground Service ← fails loud while the gate is closed
└── verification chain ← runtime-substrate.json + Reality Gate
```

## Known risks (facts as of 2026-08-17)

| Item | Fact | Handling |
| --- | --- | --- |
| Node engine | official requires `^22.19.0 \|\| >=24.0.0`; as observed on 2026-09-02, the latest stock nodejs-mobile Android release is Node 18.20.4 | **Hard blocker**: stock nodejs-mobile cannot be treated as a compatible substrate; first prove a Node 22.19+ Android runtime |
| Native `sharp` | used only by `attachment-local`, no Android prebuilt | disable attachment/image plugin on mobile, or NDK cross-compile + registry entry |
| Gradle integration | restored Labs source declared `com.github.nodejs-mobile`, but no verified current integration evidence exists | removed from the active Gradle configuration rather than claiming a working Node 22 integration |
| Background keep-alive | OS kills background processes | Foreground Service + persistent notification (also serves as approval entry) |
| Distribution channel | Play Store scrutiny of "runs arbitrary plugin code" | GitHub Releases direct APK + digest, not Play |

## Reality Gate gates (Android specific)

```text
reproducible compatible Node 22.19+ Android substrate
  → Termux on-device verification (scripts/termux-verify.sh green)
  → official @deepseek-ai/dsh@0.1.2-alpha.4 starts on that substrate
  → embedded-runtime E2E
  → APK contract tests
  → arm64 real-device + x86_64 emulator smoke
  → release evidence
```

Stay `[UNVERIFIED]` until gates pass. Verification results must quote real
output from `$HOME/.dsh/termux-verify.log` — "should work" is not evidence.

## Verification entry

```bash
# inside Termux
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community && bash scripts/termux-verify.sh
```

## Machine state

See [`apps/android/runtime-substrate.json`](../apps/android/runtime-substrate.json). Android must not be described as a runnable APK until `BLOCKED` is promoted by real evidence.
