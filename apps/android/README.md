# DSH Community Android

This is the first-party Android endpoint source for DSH Community.

- **Target architecture:** lightweight **Remote Client**. Android does not carry Node.js, `@deepseek-ai/dsh`, a repository/toolchain, credentials, Agent loop, Session store, or tool executor.
- **Execution Host:** official DeepSeek Harness runs on a trusted desktop/server Host and is projected through the Community Remote Host Adapter using verified public seams only.
- **Transport target:** Noise IK E2EE over LAN direct -> WebRTC P2P -> Community-owned blind WebSocket relay fallback.
- **Status:** `[LABS]` / `[UNVERIFIED]`. No Remote transport or Android production acceptance is claimed yet. See [Remote Host-Client Architecture](../../docs/remote-host-client.md) and issue #67.
- **Migration rule:** the embedded Node/DSH work below is retained only as **legacy embedded-runtime evidence** until the remote path reaches its Android migration gate. It is no longer the target product architecture and must not be interpreted as the Android release path.

## Legacy embedded-runtime evidence (migration-only)

- **Historical runtime target:** official `@deepseek-ai/dsh@0.2.2-rc.2` embedded on Android (kept updated as legacy embedded-runtime evidence alongside the Remote Client target).
- **Historical status:** runtime substrate `BLOCKED`; no Android Published Latest artifact was claimed.
- **Current blocker:** official DSH 0.2.2-rc.2 requires Node `>=24.9.0`; the latest stock nodejs-mobile Android release observed on 2026-09-02 is Node 18.20.4 (and even the historical `v22.19.0` carrier probe is now behind `engines.node`). The restored Labs Gradle plugin declaration was removed instead of being presented as a working modern Node integration.
- **Package-closure blocker:** the published top-level `@deepseek-ai/dsh` package eagerly pulls the current native closure; profile-only row disabling does not remove those install dependencies. Run `node scripts/audit-android-official-cli-closure.mjs`.
- **Reality gate:** compatible Node `>=24.9.0` Android substrate → `scripts/termux-verify.sh` → embedded-runtime E2E → APK smoke on arm64/x86_64 → release evidence.
- **Machine state:** see [runtime-substrate.json](runtime-substrate.json), [native-blockers.json](native-blockers.json), [native-compatibility.json](native-compatibility.json), and [evidence/reality-gate.json](evidence/reality-gate.json).
- **G2 portable audit:** `node scripts/audit-android-portable-deps.mjs` proves from the committed runtime lock that the exact sharp 0.35.5 WASM fallback (`@img/sharp-wasm32@0.35.5`) is recorded, while `@vscode/ripgrep@1.18.0` still has no Android platform package.
- **Ripgrep seam audit:** `node scripts/audit-android-ripgrep-seam.mjs --source /abs/deepseek-harness/packages/util/ripgrep/src/index.ts --expected-git-blob e9ca71e63618acc75b8cd3308d38c42e423354f8` verifies the exact audited official 0.2.2-rc.2 resolver source (which `tool-fs-search/src/search-core.ts` re-exports at blob `970846b99a6d00d1a2f1fa259d0250f6e7fab64f`). Current verdict: `resolveRgPath()` has no injection parameter/config/env seam and Node mode directly imports `@vscode/ripgrep`; the only sidecar path is `process.pkg`-gated. Community does not fork/copy official glob/grep merely to replace binary resolution.
- **Upstream drift gate:** every future official DSH candidate must also run `node scripts/audit-android-upstream-drift.mjs --official-source-root /abs/deepseek-harness`. A non-zero `REVIEW_REQUIRED` means upstream changed an Android-relevant seam/semantics; stop and re-adjudicate before carrying PTY/sandbox/preflight/fs-search assumptions forward.
- **G2 native probe:** `scripts/android-native-addon-probe.sh` rebuilds the frozen node-pty/Koffi sources without downloading or patching them, then optionally runs real-device Koffi/PTTY/sharp-WASM smoke.
- **Sandbox path:** Android uses an official CLI `--patch` overlay to replace only the `ctx.sandbox` provider with a first-party Community adapter. `scripts/android-sandbox-landlock-probe.sh` cross-builds the unmodified `src/main.c` shipped by frozen `@deepseek-ai/node-addon-system@0.1.2`; the provider accepts only a fully-enforced Landlock probe.
- **APK app-UID preflight:** `android-app-uid-preflight.cjs` runs before official DSH spawn. It performs an actual Node `fs.linkSync()` check in app-private storage and repeats Landlock full + allow/deny confinement under the APK UID. Android Context must supply `filesDir` / `cacheDir` through `DSH_ANDROID_APP_DATA_DIR` and `DSH_ANDROID_CACHE_DIR`. Source wiring is not a PASS; Reality Gate evidence remains `NOT_RUN`.
- **PTY path:** Android now replaces only the `ctx.subprocess` provider through the official patch layer. `AndroidSubprocessRuntime` subclasses official `LocalSubprocessRuntime` and overrides only `spawnTerminal()`; ordinary spawn/resolve/tree ownership remains official. The Android PTY backend uses `/proc` start-time identity fences, process-group signalling, POSIX-session cleanup, and conservative `inputWaiting=false` when Android cannot prove stdin wait. `node-pty` remains a frozen official transitive dependency, not a Community direct dependency. The native device gate now chains a provider-level adb-shell smoke using the actual Android inspector/terminal handle and checks write → foreground SIGINT → post-signal recovery → session cleanup. Its marker explicitly says `NOT_APP_UID_ACCEPTANCE`; the gate remains BLOCKED until exact-carrier build/load plus the APK app-UID official Web `minimal` persistent-terminal flow passes.
- **Release gate:** `node scripts/verify-android-release-ready.mjs` is intentionally fail-closed while any carrier/native/device/APK evidence is incomplete.
- **Evidence backing:** `scripts/validate-android-evidence-backing.mjs` requires every promoted PASS in `evidence/reality-gate.json` to have a matching version-bound record under `evidence/records/`. Records do not promote gates by themselves and cannot override unresolved architecture blockers such as the current ripgrep seam.
- **Evidence creator:** `scripts/create-android-evidence-record.mjs` creates records from real probe transcripts and local artifact bytes, computes SHA-256 itself, accepts only hashed device IDs, and refuses overwrite. Do not hand-author PASS records.
- **Substrate decision:** [中文](../../docs/android-runtime-substrate.md) / [English](../../docs/android-runtime-substrate.en.md).
- **Boundary:** DeepSeek DSH only. No Codex runtime and no third-party Remote implementation are included.

Historical source was developed by this project in Community Labs and is restored here as first-party code.

See [Android endpoint](../../docs/android-endpoint.en.md) / [中文](../../docs/android-endpoint.md).
