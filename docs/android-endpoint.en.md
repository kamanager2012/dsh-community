# Android Fifth Community Endpoint (Mobile)

> Status: `[UNVERIFIED]`. On 2026-09-02 the existing Android source was restored
> from archived Labs into the active `apps/android` tree. No published Android capability is claimed before its Reality Gate passes.

[中文](android-endpoint.md) · [Reality Gate](reality-gate.en.md)

## Positioning

Android is the **fifth Community endpoint** (after WSL/Linux Terminal, Windows Desktop,
macOS Desktop, and Linux AppImage). Its source is active in this repository, but it is not yet part of Published Latest. The product
shape is an APK: a WebView shell + `nodejs-mobile` embedding the official
`@deepseek-ai/dsh` runtime — the same Official-Runtime-Centric thin-shell
pattern as the rest of Community. No Agent loop reimplementation.

## Architecture

```text
APK
├── WebView            ← loads the local official Web UI (same as Desktop)
├── nodejs-mobile      ← embedded Node.js running official @deepseek-ai/dsh
├── Foreground Service ← runtime keep-alive + approval system notifications
└── verification chain ← reuse marketplace / registry digest checks
```

## Known risks (facts as of 2026-08-17)

| Item | Fact | Handling |
| --- | --- | --- |
| Node engine | official requires `^22.19.0 \|\| >=24.0.0` | run `scripts/termux-verify.sh` first; re-verify nodejs-mobile's Node version before APK-izing |
| Native `sharp` | used only by `attachment-local`, no Android prebuilt | disable attachment/image plugin on mobile, or NDK cross-compile + registry entry |
| Build chain `esbuild` | has android-arm64 prebuilt | no blocker |
| Background keep-alive | OS kills background processes | Foreground Service + persistent notification (also serves as approval entry) |
| Distribution channel | Play Store scrutiny of "runs arbitrary plugin code" | GitHub Releases direct APK + digest, not Play |

## Reality Gate gates (Android specific)

```text
Termux on-device verification (scripts/termux-verify.sh green)
  → official runtime has no native dependency blocker on Android
  → nodejs-mobile loads the runtime (E2E)
  → APK contract tests (reuse contracts/tests)
  → cross-platform smoke (arm64 + x86_64 emulator)
  → registry digest + release
```

Stay `[UNVERIFIED]` until gates pass. Verification results must quote real
output from `$HOME/.dsh/termux-verify.log` — "should work" is not evidence.

## Verification entry

```bash
# inside Termux
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community && bash scripts/termux-verify.sh
```
