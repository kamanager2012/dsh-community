# Android Fifth Community Endpoint (Mobile)

> Status: `[LABS]` / `[UNVERIFIED]`. Android remains the fifth Community endpoint, but its target has changed from an embedded local runtime to a lightweight Remote Client. No published Android capability is claimed before Remote Android Acceptance passes.

[中文](android-endpoint.md) · [Runtime Substrate](android-runtime-substrate.en.md) · [Reality Gate](reality-gate.en.md)

## Positioning

Android is the **fifth Community endpoint** (after WSL/Linux Terminal, Windows Desktop,
macOS Desktop, and Linux AppImage). Its source is active in this repository, but it is not yet part of Published Latest. The target is now an APK Remote Client: official `@deepseek-ai/dsh` runs only on a trusted Host, while Android handles Session / Prompt / event-stream / approval / question interaction. Android carries no Node runtime, Agent loop, Session store, or tool executor. See [Remote Host-Client Architecture](remote-host-client.md).

## Target architecture

```text
Official DSH Host
    ↓ verified public seams
Remote Host Adapter
    ↓ Noise IK E2EE
LAN → WebRTC P2P → blind WS Relay
    ↓
Android Remote Client
```

The Host is the sole execution and durable-state center. The old Node/substrate/PTY/sandbox/ripgrep Reality Gate is retained only as **legacy embedded-runtime migration evidence** until the Remote path is accepted.

## Legacy embedded-runtime evidence

## Known risks (facts as of 2026-08-17)

| Item | Fact | Handling |
| --- | --- | --- |
| Node engine | official requires `^22.19.0 \|\| >=24.0.0`; as observed on 2026-09-02, the latest stock nodejs-mobile Android release is Node 18.20.4 | **Hard blocker**: stock nodejs-mobile cannot be treated as a compatible substrate; first prove a Node 22.19+ Android runtime |
| Native `sharp` | used only by `attachment-local`, no Android prebuilt | disable attachment/image plugin on mobile, or NDK cross-compile + registry entry |
| Gradle integration | restored Labs source declared `com.github.nodejs-mobile`, but no verified current integration evidence exists | removed from the active Gradle configuration rather than claiming a working Node 22 integration |
| Background keep-alive | OS kills background processes | Foreground Service + persistent notification (also serves as approval entry) |
| Distribution channel | Play Store scrutiny of "runs arbitrary plugin code" | GitHub Releases direct APK + digest, not Play |

## Reality Gate gates (Android specific)

```text
reproducible compatible Node 22.19+ Android substrate
  → Termux on-device verification (scripts/termux-verify.sh green)
  → official @deepseek-ai/dsh@0.1.2-alpha.4 starts on that substrate
  → embedded-runtime E2E
  → APK contract tests
  → arm64 real-device + x86_64 emulator smoke
  → release evidence
```

Stay `[UNVERIFIED]` until gates pass. Verification results must quote real
output from `$HOME/.dsh/termux-verify.log` — "should work" is not evidence.

## Verification entry

```bash
# inside Termux
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community && bash scripts/termux-verify.sh
```

## Machine state

See [`apps/android/runtime-substrate.json`](../apps/android/runtime-substrate.json). Android must not be described as a runnable APK until `BLOCKED` is promoted by real evidence.
