# Android Local Runtime Substrate Decision

> Status: **BLOCKED / candidate identified**. Android remains the active fifth Community endpoint. This document defines the physical/runtime prerequisites for local official DSH execution; it does not promote unverified work into a product claim.

## Decision

Stock `nodejs-mobile` is no longer treated as a viable alpha.4 substrate:

- official `@deepseek-ai/dsh@0.1.2-alpha.4`: Node `^22.19.0 || >=24.0.0`
- latest stock nodejs-mobile Android release observed on 2026-09-02: Node `18.20.4`

The primary candidate is now:

> **Cross-build official Node.js `v22.19.0` source for Android using Node's own Android NDK configure path.**

The candidate is pinned to Git object identity, not just a version string:

- verified annotated tag object: `a9d4750074c7b5439c61daa28ea9afb5dc28e43e`
- tag target commit: `f8fe6858549f75a4b4e9633abf39dd2038dbf496`
- the probe requires local `refs/tags/v22.19.0`, its peeled commit, and HEAD to match those exact objects, with no tracked source modifications.

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

### G0 — Published CLI installation closure

Run:

```bash
node scripts/audit-android-official-cli-closure.mjs
```

The current expected report is:

```text
status = BLOCKED_BY_NATIVE_CLOSURE
profileOnlyMitigation = INEFFECTIVE
```

This is a package-topology fact, not a profile configuration bug. Published
`@deepseek-ai/dsh@0.1.2-alpha.4` eagerly depends on `dsh-base`,
`sdk-minimal`, and `tool-fs-search`; `dsh-base` in turn depends on
`subprocess-local`, `attachment-local`, `sandbox-local`, and
`tool-fs-search`. Disabling Cordis rows changes runtime composition but does
not remove `node-pty`, `koffi`, `sharp`, sandbox native backends, or
packaged ripgrep from the npm installation closure.

This leaves three explicit routes:

1. **Preferred:** keep the published top-level official `@deepseek-ai/dsh` and port/cross-build its native closure for Android under Reality Gates.
2. **Upstream:** if official DSH later makes the CLI/bundle/native packages Android-safe or optional, re-extract contracts and adjudicate again.
3. **Not automatic:** assemble lower-level official packages without the published top-level CLI. The modules would still be official, but this changes the product's runtime-source boundary and requires a separate architecture review.

Until G0 changes, “a slim Android profile fixes compatibility” is an invalid claim.

### G1 — Node carrier

```bash
NODE_SOURCE_DIR=/abs/node-v22.19.0 \
ANDROID_NDK_HOME=/abs/android-ndk \
bash scripts/android-node22-probe.sh verify
```

The gate must prove the exact verified Node tag object and commit, a successful official Android cross-build, execution on a real Android device, `process.versions.node === "22.19.0"`, and `process.platform === "android"`.

### Release fail-closed

Android publication readiness is machine-gated:

```bash
node scripts/verify-android-release-ready.mjs
```

Today this command must fail with `android-release-ready: BLOCKED`. It can only pass when the runtime substrate/carrier, selected native closure, every blocker, real-device evidence, official DSH boot, arm64 APK smoke, x86_64 emulator smoke, carrier/APK SHA-256 evidence, and the app runtime gate all agree on PASS.

The explicit empty evidence record is `apps/android/evidence/reality-gate.json` and remains `NOT_RUN`; code or documentation presence is never evidence of a completed Android gate.

### G2 — Native closure

Every blocker must be resolved by an Android-native implementation, an explicit official-DSH composition that removes that capability, or upstream Android support. “Probably not imported” is not evidence.

### G2 — Separate native-addon proof from Android runtime semantics

G2 is now explicitly split. A successful native build is not a complete compatibility verdict.

Machine sources:

- `apps/android/native-compatibility.json`
- portable-dependency audit: `scripts/audit-android-portable-deps.mjs`
- native-addon manual probe: `scripts/android-native-addon-probe.sh`
- frozen-source sandbox NDK probe: `scripts/android-sandbox-landlock-probe.sh`
- Android composition overlay: `apps/android/nodejs-project/src/main/js/android.cordis.patch.yml`
- APK app-UID startup preflight: `apps/android/nodejs-project/src/main/js/android-app-uid-preflight.cjs`

#### G2-A — Build/load the unmodified frozen addons

After G1, provide a classic `node_modules` tree staged from the committed alpha.4 runtime lock, the exact Node `v22.19.0` source/build, Android NDK, and adb for device/verify mode:

```bash
RUNTIME_DIR=/abs/runtime-stage \
NODE_SOURCE_DIR=/abs/node-v22.19.0 \
ANDROID_NDK_HOME=/abs/android-ndk \
bash scripts/android-native-addon-probe.sh verify
```

The probe downloads nothing and does not patch upstream source:

- `node-pty@1.2.0-beta.15` is rebuilt through the Node Android GYP/NDK environment from upstream commit `8f218f6c194be81d98b1eeea344b150e83445824`.
- `koffi@3.1.6` is built from the frozen package's original CMake source using the Android NDK toolchain.
- device mode runs a Koffi `getpid()` FFI smoke, a node-pty `/system/bin/sh` PTY smoke, and a frozen `sharp@0.35.4` → `@img/sharp-wasm32@0.35.4` 2×2 PNG smoke.
- The sharp WASM package must already be materialized in the frozen staging tree; if host-specific `npm ci` omitted the optional package, the probe fails explicitly with a materialization gap rather than treating lock metadata as shipped bytes.

The probe deliberately does not pre-fix `-lutil`, Bionic, N-API, or linker failures. If the unmodified build fails, that exact failure becomes evidence for the next reviewed compatibility patch.

#### G2-B — Addon loadability is not official DSH runtime compatibility

Even a G2-A PASS leaves independent hard gates:

1. **Terminal / PTY:** ordinary `LocalSubprocessRuntime.spawn()` does not resolve a terminal inspector; only `spawnTerminal()` enters `createProcessInspector()`. The Web default `standard` preset has no PTY stack, but the shipped `minimal` preset remains user-selectable and mounts persistent PTY. `AgentPresets` has no preset allowlist, so Android cannot honestly remove only minimal from the shipped roster. The local provider's `terminalInspector` property is explicitly a test hook and is not accepted as a production compatibility seam. Full endpoint release therefore still needs a production Android `SubprocessRuntime` provider or upstream Android PTY support.
2. **Sandbox:** this now has a production-shaped route. The public `@deepseek-ai/dsh-sandbox` service is the official provider seam. The Android `--patch` overlay disables only the official `sandbox-local` row and inserts the Community `AndroidLandlockSandboxProvider`; the official bundle is untouched. The provider derives grants from official `writableRoots(policy)`, speaks only the frozen `@deepseek-ai/node-addon-landlock-run@0.1.1` CLI, preserves exit-125 plus `landlock-run:` failure classification, and advertises `full` only after an exact `landlock: fully enforced` probe. The frozen npm package itself publishes `src/main.c`; `scripts/android-sandbox-landlock-probe.sh` cross-builds that source with the NDK without downloading or patching it. The embedded Node `android-app-uid-preflight.cjs` repeats the full probe **before** official DSH spawn and proves one allowed write plus one denied sibling write under the same APK UID. Wiring alone is still not device evidence.
3. **POSIX hard-link publication:** alpha.4 session persistence and attachment storage still use `link()` on non-win32 paths. The embedded Node bootstrap now executes a real `fs.linkSync()` probe in the app data directory and verifies inode identity, link count, and content before starting official DSH. Only a real APK app-UID run may promote `appPrivateHardlinks` to PASS; Linux CI, Termux, and `/data/local/tmp` cannot substitute.
4. **sharp:** the frozen lock already contains exact `sharp@0.35.4`, `@img/sharp-wasm32@0.35.4`, and `@emnapi/runtime@1.11.3` entries with registry provenance and SHA-512 integrity. The sharp loader falls through to the generic WASM package after an Android native-platform miss. Remaining gates are optional-package materialization and the real-device PNG smoke.
5. **ripgrep:** `@vscode/ripgrep@1.18.0` resolves `@vscode/ripgrep-${process.platform}-${arch}`; no Android package exists, and DSH's executable sidecar path is gated on `'pkg' in process`. Building an Android `rg` alone does not solve the wrapper seam. Community will not fake the `@vscode` scope, spoof `process.pkg`, depend on Termux/system `rg`, or substitute an unpinned newer binary.
6. **ripgrep provenance:** wrapper 1.18.0 maps to Microsoft `ripgrep-prebuilt v15.0.1`, whose config pins BurntSushi/ripgrep `15.0.0` plus the Microsoft patch. Any future Android binary must preserve that provenance or pass a new upstream-version review.

G2 therefore remains **BLOCKED**. Sandbox and hard-link checks are now wired as a fail-closed APK app-UID startup preflight, so a future verified carrier cannot start official DSH without them. The remaining acceptance work is real NDK/device evidence, PTY provider support, sharp device execution, and a legitimate ripgrep seam.

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
