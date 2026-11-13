# DSH Community Android

This is the first-party Android endpoint source for DSH Community.

- **Architecture (R5 Remote-Only):** thin native Kotlin **Remote Client**. Android carries **zero** Node.js runtime (`libnode.so`, `nodejs-mobile`), **zero** `@deepseek-ai/dsh*` runtime packages, zero local Agent loop, zero Session store, and zero tool executor.
- **Execution Host:** official `@deepseek-ai/dsh` runs exclusively on a trusted Host machine and is exposed over `@dsh-community/remote-adapter`.
- **Cryptography & Key Storage:** pure-Kotlin `Noise_IK_25519_ChaChaPoly_BLAKE2b` (`Blake2b.kt`, `Curve25519.kt`, `ChaCha20Poly1305.kt`, `NoiseIkClient.kt`) using a persistent device X25519 keypair wrapped by Android Keystore hardware-backed AES-256-GCM in `noBackupFilesDir` (`android:allowBackup="false"`).
- **Transport Failover:** ordered `LAN WebSocket (ws:// / wss://) -> WebRTC DataChannel (pluggable seam) -> Community Blind Relay` (`FailoverRemoteSession.kt`), verifying monotonic `connectionEpoch`, confirmed `session.attach(afterSeq)` resume cursors, and stable `idempotencyKey` deduplication.
- **Foreground & Battery Lifecycle:** `RemoteSessionService` (`foregroundServiceType="dataSync"`) posts interactive approval notifications and records background network/reconnect telemetry while pausing reconnect bursts during OS network loss.
- **Status:** `[LABS]` / `[UNVERIFIED]`. APK compilation, JVM crypto/protocol/failover tests, live Kotlin-vs-Node E2EE interop, and APK ZIP purity run in `.github/workflows/android-remote-acceptance.yml`. Real hardware end-to-end acceptance (R6) has not run yet, so `scripts/verify-android-release-ready.mjs` and `apps/android/evidence/reality-gate.json` (`schemaVersion: 2`) stay fail-closed (`NOT_RUN`) and Android stays excluded from `Published Latest`.

## Verification

- Repository R5 contract & fail-closed gate: `pnpm test` and `node scripts/verify-android-release-ready.mjs` (exits `1` until R6 passes)
- Gradle JVM tests + live Node `RemoteHostRuntime` / `BlindRelayServer` E2EE interop + APK build: `.github/workflows/android-remote-acceptance.yml`
- Boundary rules: [Remote Host-Client Architecture](../../docs/remote-host-client.md), [Android Endpoint (EN)](../../docs/android-endpoint.en.md), [中文](../../docs/android-endpoint.md)
