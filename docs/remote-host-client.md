# Remote Host-Client Architecture

Status: **[LABS] / [UNVERIFIED]**  
Tracking: #67

This document freezes the target boundary for remote control of an official DeepSeek Harness runtime. It does **not** claim that Noise, WebRTC, relay, or Android acceptance already exists.

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

Discovery may use QR/deep-link endpoint hints and later mDNS. Discovery is not trust: Host identity is verified by the Noise static key fingerprint.

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
- Device revocation takes effect on the next authenticated request/connection.
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

### R1 — Host Adapter core

Create `packages/remote-adapter` with:

- official-seam facade;
- capability policy;
- RPC schema/types;
- idempotency state machine;
- fake-seam tests;
- no network dependency.

### R2 — LAN + Noise

- loopback/LAN byte transport;
- Noise IK handshake;
- QR pairing;
- revoke/rotate;
- reconnect and duplicate-submission tests.

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

- a second DSH Agent runtime;
- a fork of official Web;
- a cloud account service;
- a hosted SaaS Remote backend;
- a Codex bridge;
- a generic remote desktop;
- SSH replacement;
- a distributed Session database.

It is a secure, minimal remote projection of the official Host runtime.
