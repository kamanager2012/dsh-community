# DSH Community Android

This is the first-party Android endpoint source for DSH Community.

- **Architecture (R5 Remote-Only):** thin native Kotlin **Remote Client**. Android carries **zero** Node.js runtime (`libnode.so`, `nodejs-mobile`), **zero** `@deepseek-ai/dsh*` runtime packages, zero local Agent loop, zero Session store, and zero tool executor.
- **Execution Host:** official `@deepseek-ai/dsh` runs exclusively on a trusted Host machine and is exposed over `@dsh-community/remote-adapter`.
- **Cryptography & Key Storage:** pure-Kotlin `Noise_IK_25519_ChaChaPoly_BLAKE2b` (`Blake2b.kt`, `Curve25519.kt`, `ChaCha20Poly1305.kt`, `NoiseIkClient.kt`) using a persistent device X25519 keypair wrapped by Android Keystore hardware-backed AES-256-GCM in `noBackupFilesDir` (`android:allowBackup="false"`).
- **Transport & UI (R5/R6):** ordered `LAN WebSocket (ws:// / wss://) -> WebRTC DataChannel (pluggable seam) -> Community Blind Relay` (`FailoverRemoteSession.kt`), verifying monotonic `connectionEpoch`, confirmed `session.attach(afterSeq)` resume cursors, `idempotencyKey` deduplication, `dsh-remote://pair` deep-link Intent bootstrap, clickable session picker chips, and streaming `assistant/chunk` output.
- **Foreground & Battery Lifecycle:** `RemoteSessionService` (`foregroundServiceType="dataSync"`) posts interactive approval notifications and records background network/reconnect telemetry in `noBackupFilesDir`.
- **Status:** `[LABS]` / `[UNVERIFIED]` on physical hardware. APK compilation, JVM unit tests, APK ZIP purity, `assembleDebugAndroidTest`, and `x86_64` KVM emulator instrumentation (`RemoteClientInstrumentationTest`) run in `.github/workflows/android-remote-acceptance.yml`. Physical `arm64-v8a` real-device acceptance has not yet run on real phones, so `apps/android/evidence/reality-gate.json` (`schemaVersion: 2`) remains `NOT_RUN` (`arm64RealDeviceSmoke: false`) and Android remains excluded from `Published Latest`.

## Verification

- Repository R5/R6 contract & fail-closed gate: `pnpm test` and `node scripts/verify-android-release-ready.mjs` (exits `1` until physical `arm64` hardware acceptance is recorded)
- Official Host startup & pairing deep-link CLI: `pnpm --filter @dsh-community/tui exec dsh-community remote start --mdns`
- Connected ADB device or emulator R6 acceptance runner:
  ```bash
  gradle -p apps/android :app:assembleDebug :app:assembleDebugAndroidTest
  node scripts/accept-android-r6-device.mjs --serial <adb-serial>
  ```
- Gradle JVM tests + `androidTest` APK + `x86_64` KVM emulator instrumentation: `.github/workflows/android-remote-acceptance.yml`
- Boundary rules: [Remote Host-Client Architecture](../../docs/remote-host-client.md), [Android Endpoint (EN)](../../docs/android-endpoint.en.md), [中文](../../docs/android-endpoint.md)
