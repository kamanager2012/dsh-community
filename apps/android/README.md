# DSH Community Android

This is the restored first-party Android endpoint source for DSH Community.

- **Runtime:** official `@deepseek-ai/dsh@0.1.2-alpha.4` only.
- **Target architecture:** Android WebView shell + embedded compatible Node.js host; no community Agent loop, Session store, or tool executor.
- **Status:** `[UNVERIFIED]` / runtime substrate `BLOCKED`. Source is active; no Android Published Latest artifact is claimed yet.
- **Current blocker:** official DSH alpha.4 requires Node `^22.19.0 || >=24.0.0`; the latest stock nodejs-mobile Android release observed on 2026-09-02 is Node 18.20.4. The restored Labs Gradle plugin declaration was removed instead of being presented as a working Node 22 integration.
- **Package-closure blocker:** the published top-level `@deepseek-ai/dsh` package eagerly pulls the current native closure; profile-only row disabling does not remove those install dependencies. Run `node scripts/audit-android-official-cli-closure.mjs`.
- **Reality gate:** compatible Node 22.19+ Android substrate → `scripts/termux-verify.sh` → embedded-runtime E2E → APK smoke on arm64/x86_64 → release evidence.
- **Machine state:** see [runtime-substrate.json](runtime-substrate.json), [native-blockers.json](native-blockers.json), [native-compatibility.json](native-compatibility.json), and [evidence/reality-gate.json](evidence/reality-gate.json).
- **G2 portable audit:** `node scripts/audit-android-portable-deps.mjs` proves from the committed runtime lock that the exact sharp 0.35.4 WASM fallback is recorded, while `@vscode/ripgrep@1.18.0` still has no Android package/seam.
- **G2 native probe:** `scripts/android-native-addon-probe.sh` rebuilds the frozen node-pty/Koffi sources without downloading or patching them, then optionally runs real-device Koffi/PTTY/sharp-WASM smoke. Addon/WASM PASS alone does not clear terminal-inspector, sandbox, app-private hard-link, or ripgrep gates.
- **Release gate:** `node scripts/verify-android-release-ready.mjs` is intentionally fail-closed while any carrier/native/device/APK evidence is incomplete.
- **Substrate decision:** [中文](../../docs/android-runtime-substrate.md) / [English](../../docs/android-runtime-substrate.en.md).
- **Boundary:** DeepSeek DSH only. No Codex runtime and no third-party Remote implementation are included.

Historical source was developed by this project in Community Labs and is restored here as first-party code.

See [Android endpoint](../../docs/android-endpoint.en.md) / [中文](../../docs/android-endpoint.md).
