# Android Local Runtime Substrate Decision

> Status: **BLOCKED / candidate identified**. Android remains the active fifth Community endpoint. This document defines the physical/runtime prerequisites for local official DSH execution; it does not promote unverified work into a product claim.

## Decision

Stock `nodejs-mobile` is no longer treated as a viable alpha.4 substrate:

- official `@deepseek-ai/dsh@0.1.2-alpha.4`: Node `^22.19.0 || >=24.0.0`
- latest stock nodejs-mobile Android release observed on 2026-09-02: Node `18.20.4`

The primary candidate is now:

> **Cross-build official Node.js `v22.19.0` source for Android using Node's own Android NDK configure path.**

Node `v22.19.0` still ships `android_configure.py` and documents the Android build command, but its own `BUILDING.md` explicitly says Android is not a supported platform and is not covered by Node CI. This is therefore a source path we can validate ourselves, not upstream production support.

## Node 22 is necessary, not sufficient

Full DSH carries a second native closure:

| DSH surface | Native dependency | Current verdict |
|---|---|---|
| `dsh-subprocess-local` | `node-pty`, `koffi` | **HARD blocker** |
| `dsh-attachment-local` | `sharp` | **HARD blocker** |
| `dsh-sandbox-local` | Landlock launcher / Windows ACL backend | **HARD blocker** |
| `dsh-tool-fs-search` | `@vscode/ripgrep` binary | feature blocker |

A successful Node carrier therefore does **not** imply a successful full DSH Web host.

The shipped official `sdk-minimal` profile is not a ready bypass either: it still mounts `dsh-subprocess-local`, `dsh-sandbox-local`, and the persistent terminal stack.

Machine-readable state:

- `apps/android/runtime-substrate.json`
- `apps/android/native-blockers.json`

## Reality Gates

### G1 — Node carrier

```bash
NODE_SOURCE_DIR=/abs/node-v22.19.0 \
ANDROID_NDK_HOME=/abs/android-ndk \
bash scripts/android-node22-probe.sh verify
```

The gate must prove exact Node 22.19.0 source, a successful official Android cross-build, execution on a real Android device, `process.versions.node === "22.19.0"`, and `process.platform === "android"`.

### G2 — Native closure

Every blocker must be resolved by an Android-native implementation, an explicit official-DSH composition that removes that capability, or upstream Android support. “Probably not imported” is not evidence.

### G3 — Official DSH boot

On the Android carrier, prove:

```text
official @deepseek-ai/dsh@0.1.2-alpha.4
→ selected official composition
→ session create
→ model turn
→ clean shutdown
```

Agent loop, Session, tool execution, approval, and sandbox authority remain official DSH-owned.

### G4 — APK integration

Only after G1–G3:

```text
APK
→ native carrier
→ official DSH
→ loopback 127.0.0.1
→ official Web UI
```

Then run arm64 real-device, x86_64 emulator, lifecycle, thermal/power, and recovery gates.

## Explicit non-goals

- Do not delete Android Local because stock nodejs-mobile is old.
- Do not replace Local Android with a Remote-only client.
- Do not introduce Codex.
- Do not fork the DeepSeek Agent loop.
- Do not revive the archived Suite's second runtime/session authority.
- Do not publish an APK without real-device evidence.
