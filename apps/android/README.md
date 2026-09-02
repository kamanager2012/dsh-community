# DSH Community Android

This is the restored first-party Android endpoint source for DSH Community.

- **Runtime:** official `@deepseek-ai/dsh@0.1.2-alpha.4` only.
- **Target architecture:** Android WebView shell + embedded compatible Node.js host; no community Agent loop, Session store, or tool executor.
- **Status:** `[UNVERIFIED]` / runtime substrate `BLOCKED`. Source is active; no Android Published Latest artifact is claimed yet.
- **Current blocker:** official DSH alpha.4 requires Node `^22.19.0 || >=24.0.0`; the latest stock nodejs-mobile Android release observed on 2026-09-02 is Node 18.20.4. The restored Labs Gradle plugin declaration was removed instead of being presented as a working Node 22 integration.
- **Reality gate:** compatible Node 22.19+ Android substrate → `scripts/termux-verify.sh` → embedded-runtime E2E → APK smoke on arm64/x86_64 → release evidence.
- **Machine state:** see [runtime-substrate.json](runtime-substrate.json) and [native-blockers.json](native-blockers.json).
- **Substrate decision:** [中文](../../docs/android-runtime-substrate.md) / [English](../../docs/android-runtime-substrate.en.md).
- **Boundary:** DeepSeek DSH only. No Codex runtime and no third-party Remote implementation are included.

Historical source was developed by this project in Community Labs and is restored here as first-party code.

See [Android endpoint](../../docs/android-endpoint.en.md) / [中文](../../docs/android-endpoint.md).
