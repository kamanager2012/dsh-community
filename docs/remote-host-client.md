# Remote Host-Client Architecture

Status: **R1–R5 & Host CLI/WebRTC/Relay/KVM API 34 Emulator Acceptance: MERGED · Physical arm64-v8a R6 Hardware Gate: [BLOCKED / NOT_RUN]**  
Tracking: #67

This document freezes the target boundary for remote control of an official DeepSeek Harness runtime. Host Adapter LAN/WebRTC/Relay + Noise IK, self-hosted `remote relay`/`signaling` CLIs, and Kotlin thin-client KVM API 34 emulator instrumentation are implemented and tested on `main`; the Android release gate remains fail-closed until verified on physical `arm64-v8a` hardware.

## 1. Product decision

The Host owns execution. Remote clients own interaction.

Android must stop trying to carry a production Node/DSH runtime. The production-value path is a lightweight client that can:

- discover or pair with a trusted Host;
- list and attach to official sessions;
- submit a user prompt;
- render the official event stream;
- answer official user questions;
- approve or reject official approval requests;
- reconnect without duplicating an action.

The Host remains a normal development workstation/server with the repository, Git worktree, compiler/toolchain, credentials, official DSH runtime, plugins, and filesystem access.

## 2. Truth ownership

Official DeepSeek Harness remains the sole owner of:

- Agent loop and model execution;
- official Session persistence;
- official tool execution;
- approval semantics;
- user-question semantics;
- credentials and provider integration;
- official event semantics.

The Remote Adapter is a projection layer. It must not become a second runtime or a second durable Session store.

Durable conversation truth remains in official `~/.dsh`.

Community-owned remote state is limited to:

- device identity and trust records;
- transport configuration;
- bounded in-memory replay buffers;
- diagnostics and non-sensitive metrics.

Remote trust/key state belongs in Community-owned OS configuration, not in official `~/.dsh`.

## 3. Allowed official seams

Initial adapter work may only use seams already exercised by current Community surfaces and covered by upstream contracts:

- `ctx.agents`
- `session/event`
- `Agent.followup`
- `userQuestions`
- official approval seam

The adapter may also use the existing read-only official Session discovery implemented by `packages/dsh-bridge` where that does not invent a second Session format.

Forbidden:

- private/unpublished DSH internals;
- parsing stdout/stderr into business state;
- copying official event models into a Community fork;
- reimplementing tool execution;
- a generic remote shell or generic renderer filesystem bridge.

If an upstream upgrade removes or changes a required seam, contract CI must fail closed.

## 4. Component topology

```text
                  Official DeepSeek Harness
                           kernel
                             |
                    verified public seams
                             |
                 @dsh-community/remote-adapter
                   state projection + policy
                             |
                     protocol codec (RPC)
                             |
                      Noise IK session
                             |
              transport-independent byte stream
                 /             |             \
                /              |              \
          LAN direct      WebRTC P2P      WS relay fallback
                                             |
                                     blind forwarding only
                             |
                    Remote client surfaces
                    /        |         \
                   /         |          \
                Web       Android      TUI/editor
```

The same application protocol and the same end-to-end encryption layer are used across every transport. Changing transport must not change authorization or application semantics.

## 5. Transport ladder

### 5.1 LAN direct

Primary path when Host and Client can reach each other locally.

Discovery may use the implemented QR/deep-link bootstrap descriptor and mDNS endpoint hints. Discovery is not trust: Host identity is verified by the Noise static key fingerprint.

### 5.2 WebRTC P2P

Second path for NAT traversal.

WebRTC has an unavoidable signaling/ICE bootstrap requirement. Therefore “zero third-party middle server” means:

- Community-owned/self-hosted signaling;
- Community-owned/self-hosted STUN;
- no dependence on a commercial remote-control backend;
- end-to-end Noise encryption above the DataChannel.

A TURN service is not required for the first milestone because restrictive networks may fall through to the blind relay. TURN can be evaluated later from real connectivity data.

### 5.3 Blind WebSocket relay

Terminal fallback when direct/P2P paths fail.

The relay is not trusted with plaintext. It forwards opaque encrypted frames and may know only routing metadata needed to connect peers.

The relay must not receive:

- DSH credentials;
- provider API keys;
- plaintext prompts;
- plaintext events;
- plaintext approvals;
- device private keys.

## 6. Noise identity model

Target handshake pattern: **Noise IK**.

Rationale: a pairing client can know the Host static public key before connecting, which gives immediate responder authentication and allows the client static identity to be presented inside the encrypted handshake.

Pairing flow:

1. Host creates or loads a long-lived static Noise key.
2. Host generates a one-time pairing token.
3. Host displays a QR/deep link containing:
   - protocol version;
   - Host static public-key fingerprint/public key;
   - one-time token;
   - reachable endpoint hints;
   - optional signaling identifier.
4. Client generates its own static key.
5. Android stores its private key in Android Keystore.
6. First successful encrypted pairing binds the client public key to a Host-side device record.
7. The one-time token is consumed.
8. Future connections authenticate by static keys; device access can be revoked or rotated.

A transport-level TLS/DTLS session is defense in depth, not the application trust root.

## 7. Authorization

Pairing does not imply unlimited authority.

Initial device capabilities:

- `observe`
- `prompt`
- `approve`
- `answer-question`

Default deny is required. A device may be observe-only.

Explicitly out of scope for the baseline:

- arbitrary shell;
- arbitrary file browsing;
- credential management;
- plugin installation;
- provider configuration;
- host process execution unrelated to the official DSH flow.

Any later capability requires a separate threat-model review.

## 8. Application protocol

Baseline framing: **JSON-RPC 2.0 over an authenticated encrypted stream**.

Minimum request methods:

- `session.list`
- `session.attach`
- `prompt.submit`
- `approval.respond`
- `question.respond`
- `ping`

Minimum notifications:

- `stream.event`
- `stream.reset`
- `peer.revoked`

Each request/notification carries or is bound to:

- protocol version;
- connection epoch;
- authenticated device identity;
- request id;
- idempotency key for mutating operations;
- session id when applicable;
- official event sequence when applicable.

### 8.1 Prompt submission

`prompt.submit` maps to official `Agent.followup`.

The adapter must reject duplicate idempotency keys inside the same logical submission window. Reconnect/failover must not create a second turn.

### 8.2 Event streaming

Business events originate from official `session/event`.

The adapter may retain a bounded in-memory replay window keyed by official event sequence. It must not create a durable Community conversation log.

If a client resume point is no longer in memory, the adapter must issue `stream.reset` and reconstruct the view from an allowed official source instead of pretending the gap was filled.

### 8.3 Approval and questions

Approval and question responses are mutating operations and require:

- stable remote request id;
- underlying official interaction id;
- expected state/version where the official seam exposes one;
- idempotency handling;
- terminal state enforcement.

A stale reconnect must not approve an already-resolved request.

## 9. Backpressure and boundedness

Mobile clients are slow and disconnect frequently. The Host must not let one client create unbounded memory growth.

Required policies:

- bounded event replay window;
- bounded per-client outbound queue;
- event coalescing only for explicitly non-durable presentation state;
- never drop approval/question terminal transitions;
- disconnect a persistently stalled client before Host memory becomes unbounded.

The adapter is not a message broker.

## 10. Security invariants

- E2EE terminates only at Host Adapter and authenticated Client.
- Relay compromise does not expose application plaintext.
- Pairing token is single-use and short-lived.
- Device private keys are non-exportable where platform facilities allow.
- Device revocation terminates active authenticated channels and blocks subsequent authenticated reconnects.
- Host credentials never synchronize to a Client by default.
- No raw DSH_HOME export.
- No generic remote filesystem API.
- No generic remote process API.
- Mutating RPC methods are capability-gated and idempotent.
- Protocol downgrade is rejected.
- Unknown RPC methods fail closed.

## 11. Failure model

The design must explicitly survive:

- Wi-Fi to cellular transition;
- LAN -> P2P -> relay failover;
- duplicated frames;
- delayed frames;
- reconnect during model streaming;
- reconnect during an approval gate;
- revoked device reconnect;
- Host restart;
- Client process death;
- relay outage;
- upstream DSH seam drift.

Network failure is not permission to retry a mutating action blindly.

## 12. Delivery gates

### R0 — Architecture baseline

- merge this contract;
- mark embedded-Android runtime as a migration source, not the target;
- no claim of working Remote transport.

### R1 — Host Adapter core (CLOSED / MERGED)

Created `packages/remote-adapter` with:

- official-seam facade;
- capability policy;
- RPC schema/types;
- idempotency state machine;
- fake-seam tests;
- no network dependency.

### R2 — LAN + Noise (Non-mobile Host scope: CLOSED / MERGED)

- loopback/LAN byte transport (`HostLanCarrier`);
- Noise IK handshake and persistent Host identity (`FileHostIdentityStore`);
- persistent device trust with atomic WAL crash consistency (`FileDeviceTrustStore`);
- QR/deep-link bootstrap descriptor primitives plus secret-free mDNS endpoint advertisement (`BonjourMdnsAdvertiser`);
- device revoke terminates active channels and blocks future authenticated reconnects; Host identity rotation remains durable and changes the trust domain;
- fresh-epoch reconnect, Session resume/reset, and cross-reconnect idempotency;
- isolated-LAN (`netns` + `tcpdump`) acceptance evidence proving the configured Session/event/Prompt/token markers are absent from carrier plaintext (`remote-host-real-lan-acceptance.yml`).

### R3 — WebRTC P2P

- self-owned signaling;
- self-owned STUN;
- DataChannel transport;
- same Noise/application layers;
- NAT matrix evidence.

### R4 — Relay fallback

- Community-owned blind WebSocket relay;
- transport failover;
- prove relay sees ciphertext only;
- abuse/rate/resource controls.

### R5 — Android migration

- remove embedded Node/runtime packaging;
- Android becomes remote-only;
- Android Keystore device key;
- Prompt/session/event/approval/question UI;
- battery/background behavior evidence.

### R6 — Production acceptance

A real acceptance run must demonstrate:

1. pair a new Android device;
2. list official Host sessions;
3. resume an existing session;
4. submit a prompt and receive streamed events;
5. stop at an official approval gate;
6. approve/reject from Android exactly once;
7. switch network path without duplicating the action;
8. revoke the Android device and prove reconnect fails;
9. confirm Host official Session remains the sole durable truth.

## 13. Android migration rule

Do not delete the current embedded-runtime experiments in R0.

The existing Node 22 carrier, node-pty/Koffi, Landlock, sharp-WASM, ripgrep, APK-UID, PTY, and Reality-Gate material is evidence of why the local-runtime path is expensive and blocked. It should be removed or archived only in the R5 migration PR after the remote path has explicit replacement tests.

Final Android acceptance requires the APK to contain **no Node runtime and no official DSH runtime package**.

## 14. Non-goals

This architecture is not:

- a fork of official `@deepseek-ai/dsh` or official Web;
- a cloud account service;
- a hosted SaaS Remote backend;
- a generic remote desktop;
- an arbitrary interactive SSH / remote shell replacement;
- an unconstrained filesystem read/write bridge (`workspace.git.status`/`workspace.git.diff` are strictly read-only, Git-repo-contained, and symlink/flag-injection hardened);
- a distributed Session database.

It is a secure, E2EE multi-agent control plane unifying official DSH with local external coding CLIs (`Claude Code`, `Codex CLI`, `OpenCode ACP`).

## 15. R6 Official Host Bridge & Android Instrumentation

- **Official Host Cordis Bridge (`@dsh-community/remote-adapter`)**: `OfficialHostCordisBridge` and `@dsh-community/remote-adapter/cordis-plugin` attach directly inside official `@deepseek-ai/dsh --profile headless --patch ...` via Cordis events (`session/event`, `agent/assistant-stream`, `agent/error`, `approval/request`, `user-questions/request`) while keeping `DSH_REMOTE_CONFIG_DIR` strictly outside `DSH_HOME` (`~/.dsh`), emitting encrypted `peer.revoked` prior to channel teardown and `stream.reset` on replay window invalidation.
- **Host & Ops CLI (`dsh-community remote`)**:
  - `dsh-community remote start [--engines <auto|dsh,claude,codex,opencode>] [--default-engine <id>] [--host <ip>] [--port <n>] [--mdns] [--qr] [--relay-url <url>] [--signaling-url <url>] [--signaling-room <id>] [--stun <urls>] [--session <id>] [--json]`
  - `dsh-community remote relay [--host <ip>] [--port <n>] [--allow-wildcard] [--host-secret <secret>] [--json]`
  - `dsh-community remote signaling [--host <ip>] [--port <n>] [--stun-port <n>] [--allow-wildcard] [--host-secret <secret>] [--json]`
  - `dsh-community remote devices [--json]`
  - `dsh-community remote revoke <deviceId>`
  - `dsh-community remote status [--json]`
  - Unified public-network carrier defaults (honored consistently across `@dsh-community/remote-adapter`, `dsh-community remote start`, and Desktop `DesktopRemoteController`): `DSH_REMOTE_DEFAULT_RELAY_URL` (`ws:`/`wss:`), `DSH_REMOTE_DEFAULT_SIGNALING_URL` (`ws:`/`wss:`), and `DSH_REMOTE_DEFAULT_STUN_URLS` (`stun:`-only comma-separated URIs; third-party `turn:`/`turns:` fails closed per R3).
- **Android Saved Hosts, Pairing & Instrumentation**:
  - `MainActivity` handles `dsh-remote://pair?data=<base64url>` (`ACTION_VIEW`), system `ACTION_SEND` (`text/plain`), and one-tap clipboard **Paste** extraction through `PairingInputHelper` + `PairingQrParser` (never embedding session IDs or credentials inside the URI), and requests runtime `POST_NOTIFICATIONS` on Android 13+.
  - `EncryptedTrustedHostStore` (`AndroidKeyStore` AES-256-GCM in `noBackupFilesDir`) persists paired Hosts without `bootstrapToken` for tokenless reconnect, matches mDNS `_dsh-remote._tcp.` discoveries by `hostFingerprint` while preserving `discovery !== trust` for unpaired Hosts, supports Forget Host, clears stale buffers on `stream.reset`, and halts reconnects fail-closed on `peer.revoked`.
  - `apps/android/app/src/androidTest/.../RemoteClientInstrumentationTest.kt` and `scripts/accept-android-r6-device.mjs` verify `AndroidKeyStore`, `RemoteSessionService` (`dataSync`), native `AndroidWebRtcPeerEngine` (`Dead-LAN -> WebRTC P2P`), `Dead-LAN -> Blind Relay` failover, stream resume/reset, and revocation on `x86_64` KVM emulator while leaving `arm64RealDeviceSmoke` fail-closed (`false`) until verified on physical `arm64-v8a` hardware.

## 16. Multi-Agent Unified Control Plane & Scoped Git Review

- **Multi-Engine Multiplexing (`MultiAgentHostRouter`)**: `@dsh-community/remote-adapter/backends` defines `AgentHostBackend` with native adapters for:
  - `dsh` (`DshAgentBackend` via Cordis seams),
  - `claude` (`ClaudeCodeBackend` via headless `claude` stream-json stdio),
  - `codex` (`CodexCliBackend` via `codex exec --json` / `codex app-server`),
  - `opencode` (`OpenCodeAcpBackend` via ACP JSON-RPC 2.0 stdio).
- **Standalone Multi-Agent Mode (`MultiAgentRemoteHost` / `@dsh-community/remote-adapter/standalone-cli`)**: Runs end-to-end without `DEEPSEEK_API_KEY` or Cordis whenever local `claude`, `codex`, or `opencode` CLIs are configured/detected, automatically launched by `dsh-community remote start` and Desktop `DesktopRemoteController.start()` when DSH API key is absent.
- **Host Secret Scrubbing (`@dsh-community/remote-adapter/remote-env`)**: `scrubChildProcessEnv` removes control tokens, relay secrets, and signaling secrets (`DSH_REMOTE_CONTROL_TOKEN`, `DSH_REMOTE_RELAY_HOST_SECRET`, `DSH_REMOTE_RELAY_CLIENT_TOKEN`, `DSH_REMOTE_SIGNALING_HOST_SECRET`, `DSH_REMOTE_SIGNALING_JOIN_TOKEN`) before spawning any external agent subprocess.
- **Scoped Read-Only Git Code Review**:
  - RPC methods `engine.list`, `workspace.git.status`, `workspace.git.diff` (plus optional `engine` parameter on `session.create`) are exposed over Noise IK RPC and mapped to loopback control routes `GET /engines`, `GET /git/status`, and `GET /git/diff`.
  - Git inspection requires only the `observe` capability, runs `git` via `execFile` (no shell) under resolved `session.cwd`, verifies repo-root containment via `realpathSync`, blocks `..` / NUL / symlink escapes / `--option` flag injection, and bounds UTF-8 diff output cleanly at multibyte boundaries.
  - CLI (`engines`, `git <sessionId>`, `diff <sessionId> [path]`), Desktop (`remoteGitInspect` Diff viewer + engine chips), and Android (`engine.list`, multi-engine `session.create`, `[engine]` chips, read-only Diff dialog) consume these RPCs while keeping `DshApp.REAL_DEVICE_ACCEPTANCE_READY = false`.
