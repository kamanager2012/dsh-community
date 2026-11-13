# Android Third Complementary Community Endpoint (Mobile)

> Status: `[LABS]` / `[UNVERIFIED]`. Under the Complementary Edition scope, Android is the **third complementary community endpoint** (alongside WSL/Linux Terminal and Linux AppImage). In R5, `apps/android/` completed migration to a pure lightweight **Remote Client** with zero embedded Node.js or `@deepseek-ai/dsh` runtime; it remains excluded from Published Latest until R6 real-device acceptance passes.

[中文](android-endpoint.md) · [Historical Runtime Substrate Note](android-runtime-substrate.en.md) · [Remote Host-Client Architecture](remote-host-client.md)

## Scope & Architecture

- Official `@deepseek-ai/dsh` executes solely on the trusted Host. Android projects Host sessions, live event streams, follow-up prompts, approvals, and questions over `@dsh-community/remote-adapter`.
- The built Android APK must contain **no Node runtime** (`nodejs-mobile`, `libnode.so`) and **no official `@deepseek-ai/dsh*` packages**.

```text
Official DSH Host
    ↓ verified public seams
Remote Host Adapter
    ↓ Noise_IK_25519_ChaChaPoly_BLAKE2b E2EE
LAN WebSocket → WebRTC DataChannel seam → Blind WebSocket Relay
    ↓
Android Remote Client (Kotlin, noBackupFilesDir + Android Keystore AES-256-GCM)
```

- **Device identity**: `DeviceIdentityStore.kt` wraps a persistent X25519 keypair under an Android Keystore hardware-backed AES-256-GCM master key (StrongBox with TEE fallback) inside `noBackupFilesDir`, paired with `android:allowBackup="false"`.
- **Failover & Foreground Service**: `FailoverRemoteSession.kt` executes ordered `LAN -> WebRTC -> Relay` fallback (`AndroidWebRtcPeerEngine.kt` layered over `io.github.webrtc-sdk:android` carrying Noise IK frames inside DataChannels) with monotonic `connectionEpoch` validation, `session.attach(afterSeq)` resume cursors, and persistent `idempotencyKey` retries; `RemoteSessionService.kt` maintains the `dataSync` foreground service, runtime `POST_NOTIFICATIONS` onboarding (Android 13+), auto-clearing approval notifications, and network-aware backoff telemetry.
- **Pairing UX**: `MainActivity` accepts `dsh-remote://pair` deep links (`ACTION_VIEW`), system `ACTION_SEND` (`text/plain`) shares, one-tap clipboard **Paste** extraction (`PairingInputHelper`), and LAN `_dsh-remote._tcp.` discovery, paired with scannable ISO/IEC 18004 UTF-8 terminal QR output in `dsh-community remote start --qr` / REPL `qr`.
- **Migration cleanup (§13)**: the R0–R4 embedded Node 22 / `node-pty` / Koffi / Landlock / sharp-WASM / ripgrep / `nodejs-project` experiments were retired in R5 after explicit remote-client contract and live Node interop tests replaced them (historical materials remain in Git history).

## Verification & Fail-Closed Release Gate

- GitHub Actions workflow `.github/workflows/android-remote-acceptance.yml` builds `@dsh-community/remote-adapter`, runs Gradle JVM unit tests + live Kotlin-vs-Node E2EE LAN/Relay failover interop, builds both debug & minified Release R8 APKs, inspects the APK ZIP to fail on any embedded Node or DSH runtime artifact, and runs API 34 (`x86_64`) KVM instrumentation (`Dead-LAN -> WebRTC P2P`, `Dead-LAN -> Blind Relay`, Keystore persistence, and revocation).
- Machine release gate [`apps/android/evidence/reality-gate.json`](../apps/android/evidence/reality-gate.json) (`schemaVersion: 2`, `architecture: "remote-only"`, `status: "NOT_RUN"`, `arm64RealDeviceSmoke: false`) and `node scripts/verify-android-release-ready.mjs` remain fail-closed (`exit 1`) until genuine physical `arm64-v8a` hardware acceptance passes.
