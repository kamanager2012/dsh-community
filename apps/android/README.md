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

## Qualcomm (`arm64-v8a`) Sideload Signing & R6 Evidence Merge

Stock Qualcomm Snapdragon Android phones refuse to sideload `app-release-unsigned.apk` unless signed with an APK v2/v3 release key. To keep all secrets outside Git while supporting slim sideload APKs:

1. **Build a slim signed `arm64-v8a` Release APK** (cuts native WebRTC `.so` payload from 4 ABIs down to `arm64-v8a`):

   ```bash
   cd apps/android
   export DSH_ANDROID_SIGNING_REQUIRED=true
   export DSH_ANDROID_KEYSTORE_PATH=/secure/path/to/dsh-release.p12
   export DSH_ANDROID_KEYSTORE_PASSWORD='***'
   export DSH_ANDROID_KEY_ALIAS='dsh-release'
   export DSH_ANDROID_KEY_PASSWORD='***'
   gradle --no-daemon -PdshAbiFilters=arm64-v8a :app:assembleRelease
   ```

   - Partial signing configuration or `DSH_ANDROID_SIGNING_REQUIRED=true` without all four inputs fails Gradle configuration immediately.
   - For PKCS12 (`.p12`/`.pfx`) keystores, set `DSH_ANDROID_KEY_PASSWORD` equal to `DSH_ANDROID_KEYSTORE_PASSWORD` (PKCS12 stores share one password across store and key); `.jks` keystores may use distinct passwords.
   - Verify signature before sideloading (`apksigner verify --verbose app/build/outputs/apk/release/app-release.apk`).

2. **Run R6 hardware acceptance on a connected Qualcomm (`arm64-v8a`) phone and combine with CI `x86_64` emulator evidence**:

   ```bash
   node scripts/accept-android-r6-device.mjs \
     --serial <adb-serial> \
     --emulator-report /path/to/r6-emulator-acceptance.json \
     --output apps/android/evidence/reality-gate.json
   ```

   Or merge two separately captured reports via:

   ```bash
   node scripts/merge-android-r6-evidence.mjs \
     --arm64 /path/to/r6-arm64.json \
     --emulator /path/to/r6-emulator-acceptance.json \
     --out apps/android/evidence/reality-gate.json
   ```
