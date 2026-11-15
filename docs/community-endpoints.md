# Community 端定义（互补版）

官方是内核，且官方上游已直接提供 Web、Windows Desktop（`win-x64`）与 macOS Desktop（`mac-arm64` / `mac-x64`）。**社区仓定位于官方互补版**：官方已经有的端我们不做重复构建，只做官方尚未提供的互补社区端。不要混淆 **官方上游端**、**Community UI 形态**、**已发行互补端** 和 **实验端**。

[English](community-endpoints.en.md) · [中文使用指南](getting-started.md) · [在线 Handbook](https://kamanager2012.github.io/dsh-community/)

## 几个不能混为一谈的层次

| 层次 | 数量 | 含义 |
|---|---:|---|
| 官方上游已有端（社区不做） | 3 | Official Web、Windows Desktop（`win-x64`）、macOS Desktop（`mac-arm64` / `mac-x64`） |
| Community UI 形态 | 3 | Terminal / TUI、Linux Desktop（AppImage）、Mobile Remote 壳（Android APK） |
| 我们当前发行给用户的互补端 | **3** | WSL/Linux 终端、Linux AppImage、已签名 Android `arm64-v8a` Remote Client APK |
| 真机遥测待核验状态 | **1** | Android 物理 `arm64-v8a` 真机遥测仍为 `[UNVERIFIED]`（CI `x86_64` 模拟器 E2EE 已验收通过，已签名 APK 已进入 Published Latest） |

官方 Web 与 Windows / macOS Desktop 归 DeepSeek 官方所有。它们与 Community 共享 `~/.dsh`，但**不是互补社区端**。（历史版本 `v0.1.1-rc.2` 曾附带过 Win/macOS 安装包，自互补版收敛起正式退役，`--win` / `--mac` fail-closed 拒绝构建。）

## 三个互补 Community endpoints：全部已发行（Android 真机遥测 `[UNVERIFIED]`）

```text
                    Official DeepSeek Harness Runtime
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
 WSL / Linux Terminal     Linux AppImage          Android Mobile
    (TUI / CLI)             (Linux GUI)        (Remote Client APK)
        ①                       ②                       ③
```

| # | 互补社区端 | 产物 | 成熟度 |
|---|---|---|---|
| 1 | WSL / Linux 终端 | `dsh-community` / `pnpm tui` | Stable（源码主力） |
| 2 | Linux 桌面 AppImage | `dsh-community-*.AppImage` | Beta（Linux 唯一官方未覆盖的桌面互补包；CLI 用户仍以终端为主） |
| 3 | Android Mobile | `dsh-community-*-android-arm64-v8a.apk` | 已在 Published Latest 发行已签名 `arm64-v8a` APK（CI `x86_64` 模拟器 E2EE PASS；物理 `arm64-v8a` 真机遥测 `[UNVERIFIED]`） |

### 1. WSL / Linux 终端

面向开发者、CLI 用户、Agent 重度用户、WSL2 Ubuntu 和 Linux Server 用户。

```sh
dsh-community
dsh-community new
dsh-community resume last
dsh-community sessions
dsh-community doctor
dsh-community plugins
```

这是 Linux 的 CLI 主路径。不强制此类用户安装 AppImage。

### 2. Linux 桌面 AppImage

面向需要图形桌面、且官方尚未覆盖 Linux 桌面打包的 Linux 用户。它是正式发行互补端中的第 2 端，不是“随便附带的构建垃圾”。

同时：WSL / 无桌面服务器用户的默认路径仍是终端，不要告诉他们必须装 AppImage；Windows 与 macOS 用户请直接使用官方 `deepseek-harness` 桌面版或命令行。

### 3. Android Mobile（已发行 `arm64-v8a` APK / 真机遥测 `UNVERIFIED`）

架构为轻量 **Remote Client**：Android 不内嵌 Node 或官方 `@deepseek-ai/dsh`，而是通过 Community Remote Host Adapter 连接可信 Host；Host 保留官方 Runtime、仓库/工具链、凭证、工具执行和 `~/.dsh` Session 真源。传输采用 Noise IK E2EE，链路按 LAN 直连 → WebRTC P2P → Community-owned blind WebSocket Relay 降级。每个 Release 均构建并发布经 APK v2/v3 与 Keyless Cosign 双签名的 `dsh-community-*-android-arm64-v8a.apk`（通过 CI `x86_64` 模拟器 E2EE 全链路门禁；物理 `arm64-v8a` 手机真机遥测仍标为 `[UNVERIFIED]`）。见 [`remote-host-client.md`](remote-host-client.md)。

## 官方既有端（Web / Windows / macOS）不是我们的产品

```text
                    DeepSeek Harness Runtime
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
          ▼                 ▼                  ▼
  Upstream Surfaces     Community TUI      Community GUI / Mobile (Complementary)
  DeepSeek ships        we ship            shipped on Published Latest
  ├── Official Web                         ├── Linux AppImage
  ├── Windows Desktop                      └── Android arm64-v8a APK (physical handset telemetry [UNVERIFIED])
  └── macOS Desktop
```

正确说法：

> 一套官方 Runtime，三个互补 Community endpoints（WSL/Linux 终端、Linux AppImage、Android `arm64-v8a` Remote Client APK）；三者均已发行，其中 Android 通过 CI `x86_64` 模拟器 E2EE 验收，物理 `arm64-v8a` 真机遥测保持 `[UNVERIFIED]`；Web 与 Windows/macOS Desktop 交由官方上游维护，全部与官方共用同一份 `~/.dsh`。

错误说法：

> 我们有 Web + Desktop + Terminal 三端。 / 我们继续代替官方打包 Windows 和 macOS 安装包。

这种说法会让人误以为 Community 与官方重复造轮子或拥抱了官方已覆盖的端。

## 对外口号

优先使用：

> **One Harness. Three complementary community endpoints — all published in Latest; Android physical `arm64-v8a` handset telemetry remains `[UNVERIFIED]`.**

> **一套 Harness，三个互补社区端：WSL/Linux 终端、Linux AppImage、Android（Remote APK）；三端均已发行，Windows/macOS 与 Web 交还官方上游，Android 物理真机遥测保持 `[UNVERIFIED]`。**

同时说明：

> 与官方 Web 及官方桌面端共用官方 `~/.dsh` Session 存储。Official Web 与 Windows/macOS Desktop 不是 Community 互补发行端。
