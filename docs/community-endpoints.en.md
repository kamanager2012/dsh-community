# Community endpoints (Complementary Edition)

Official is the kernel, and official `deepseek-ai/deepseek-harness` already owns Official Web, Windows Desktop (`win-x64`), and macOS Desktop (`mac-arm64` / `mac-x64`). **dsh-community is the Complementary Edition**: we do not duplicate upstream surfaces; we build only the missing complementary endpoints. Do not mix **upstream surfaces**, **UI surfaces**, **shipped endpoints**, and **hardware verification states**.

[简体中文](community-endpoints.md) · [Getting started](getting-started.en.md) · [Online Handbook](https://kamanager2012.github.io/dsh-community/en/)

## Layers that must not be mixed

| Layer | Count | Meaning |
|---|---:|---|
| Upstream-owned surfaces (not duplicated here) | 3 | Official Web, Windows Desktop (`win-x64`), macOS Desktop (`mac-arm64` / `mac-x64`) |
| Community UI surfaces | 3 | Terminal / TUI, Linux Desktop (AppImage), Mobile Remote shell (Android APK) |
| Complementary endpoints shipped to users | **3** | WSL/Linux Terminal, Linux AppImage, signed Android `arm64-v8a` Remote Client APK |
| Hardware telemetry gate | **1** | Android physical `arm64-v8a` handset telemetry remains `[UNVERIFIED]` (CI `x86_64` emulator E2EE verified; signed APK shipped on Published Latest) |

Official Web and Windows/macOS Desktop belong to DeepSeek upstream. They share `~/.dsh` with Community, but they are **not** Complementary Community endpoints. (Historical `v0.1.1-rc.2` shipped Win/macOS installers prior to this Complementary Edition narrowing; `--win` / `--mac` now fail closed.)

## Three complementary Community endpoints: all published in Latest (Android physical handset telemetry `[UNVERIFIED]`)

```text
                    Official DeepSeek Harness Runtime
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
 WSL/Linux Terminal      Linux AppImage          Android Mobile
    (TUI / CLI)            (Linux GUI)        (Remote Client APK)
        ①                       ②                       ③
```

| # | Endpoint | Artifact | Maturity |
|---|---|---|---|
| 1 | WSL / Linux Terminal | `dsh-community` / `pnpm tui` | Stable (primary source path) |
| 2 | Linux Desktop AppImage | `dsh-community-*.AppImage` | Beta (Linux graphical build absent upstream; CLI users still start at Terminal) |
| 3 | Android Mobile | `dsh-community-*-android-arm64-v8a.apk` | Signed `arm64-v8a` APK shipped on Published Latest (CI `x86_64` emulator E2EE PASS; physical `arm64-v8a` handset telemetry `[UNVERIFIED]`) |

### 1. WSL / Linux Terminal

For developers, CLI users, Agent-heavy users, WSL2 Ubuntu, and Linux servers:

```sh
dsh-community
dsh-community new
dsh-community resume last
dsh-community sessions
dsh-community doctor
dsh-community plugins
```

This is the primary Linux CLI path. An AppImage is not required for this user.

### 2. Linux Desktop AppImage

For Linux users who want a graphical desktop absent from official `deepseek-harness` packaging. This is shipped Complementary endpoint 2, not an accidental build leftover. WSL / headless-server users still start at the Terminal; Windows and macOS users use official `deepseek-harness`.

### 3. Android Mobile (shipped `arm64-v8a` APK / physical handset telemetry `UNVERIFIED`)

Architecture is a lightweight **Remote Client**: official `@deepseek-ai/dsh` runs only on a trusted Host, while Android handles Session / Prompt / event-stream / approval / question interaction over Noise IK E2EE. Android carries no Node runtime, Agent loop, Session store, or tool executor. See [Remote Host-Client Architecture](remote-host-client.md). The signed `dsh-community-*-android-arm64-v8a.apk` (APK Signature Scheme v2/v3 + Keyless Cosign) is published on GitHub Latest after passing CI `x86_64` emulator E2EE acceptance, while physical `arm64-v8a` handset telemetry remains explicitly labeled `[UNVERIFIED]`.

## Upstream Web & Win/macOS Desktop are not our products

Correct claim:

> One official Runtime. Three complementary Community endpoints (WSL/Linux Terminal, Linux AppImage, and signed Android `arm64-v8a` Remote Client APK) — all published in Latest, with Android physical `arm64-v8a` handset telemetry labeled `[UNVERIFIED]`. Official Web and Win/macOS Desktop live upstream; everything shares `~/.dsh`.

Incorrect claim:

> We have Web + Desktop + Terminal / We duplicate Windows & macOS installers.

That wording implies Community builds or owns official upstream surfaces.

## Slogan

Prefer:

> **One Harness. Three complementary community endpoints — all published in Latest; Android physical `arm64-v8a` handset telemetry remains `[UNVERIFIED]`.**

Chinese:

> **一套 Harness，三个互补社区端：WSL/Linux 终端、Linux AppImage、Android（Remote APK）；三端均已发行，Windows/macOS 与 Web 交还官方上游，Android 物理真机遥测保持 `[UNVERIFIED]`。**

Always add:

> Shares the official `~/.dsh` session store with official Web and official Win/macOS Desktop. Neither Web nor Win/macOS Desktop is a Complementary Community endpoint.
