# DSH Community Android

This is the restored first-party Android endpoint source for DSH Community.

- **Runtime:** official `@deepseek-ai/dsh@0.1.2-alpha.4` only.
- **Architecture:** Android WebView shell + embedded Node.js host; no community Agent loop, Session store, or tool executor.
- **Status:** `[UNVERIFIED]`. Source is active; no Android Published Latest artifact is claimed yet.
- **Reality gate:** `scripts/termux-verify.sh` → embedded-runtime E2E → APK smoke on arm64/x86_64 → release evidence.
- **Boundary:** DeepSeek DSH only. No Codex runtime and no third-party Remote implementation are included.

Historical source was developed by this project in Community Labs and is restored here as first-party code.

See [Android endpoint](../../docs/android-endpoint.en.md) / [中文](../../docs/android-endpoint.md).
