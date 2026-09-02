# Community 端定义

官方是内核，社区基于官方内核。下面按当前真实发行状态定义产品端；不要混淆 **操作系统目标**、**UI 形态**、**已发行端** 和 **实验端**。

[English](community-endpoints.en.md) · [中文使用指南](getting-started.md) · [在线 Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/)

## 三个不能混为一谈的层次

| 层次 | 数量 | 含义 |
|---|---:|---|
| 代码可以构建的 OS 目标 | 4 | Linux、Windows、macOS、Android |
| Community UI 形态 | 3 | Terminal / TUI、Desktop、Mobile 壳 |
| 我们发行给用户的社区端 | **4** | WSL/Linux 终端、Windows 桌面、macOS 桌面、Linux AppImage |
| 活跃但未发行端 | **1** | Android `[UNVERIFIED]`；源码位于本仓 `apps/android`，尚未进入 Published Latest |

官方 Web 是 DeepSeek 官方界面。它与 Community 共享 `~/.dsh`，但**不是社区端**。

## 五个 Community endpoints：四个已发行 + Android 活跃 / UNVERIFIED

```text
                    Official DeepSeek Harness Runtime
                                │
     ┌──────────┬───────────────┼───────────────┬──────────┐
     ▼          ▼               ▼               ▼          ▼
 WSL/Linux   Windows         macOS          Linux       Android
  Terminal   Desktop         Desktop        AppImage     Mobile
    ①          ②               ③              ④           ⑤
```

| # | 社区端 | 产物 | 成熟度 |
|---|---|---|---|
| 1 | WSL / Linux 终端 | `dsh-community` / `pnpm tui` | Stable（源码主力） |
| 2 | Windows 桌面 | `DSH Community Setup.exe` | Stable（已发布 Latest） |
| 3 | macOS 桌面 | `dsh-community-*.dmg` | Stable（已发布 Latest） |
| 4 | Linux 桌面 AppImage | `dsh-community-*.AppImage` | Beta（随 Release 附带；Linux CLI 用户仍以终端为主） |
| 5 | Android Mobile | APK 原型（WebView + nodejs-mobile） | 活跃源码在 `apps/android`；`[UNVERIFIED]`，不进 Published Latest |

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

### 2. Windows 桌面

面向不想先安装 Node 或 CLI 的 Windows 用户。

```text
DSH Community Setup.exe
→ install → API key → use
```

### 3. macOS 桌面

macOS 用户的路径相同：

```text
dsh-community-*.dmg
→ install → API key → use
```

### 4. Linux 桌面 AppImage

面向需要图形桌面、但不走 Windows/macOS 安装包的 Linux 用户。它是四个正式发行入口中的第 4 端，不是“随便附带的构建垃圾”。

同时：WSL / 无桌面服务器用户的默认路径仍是终端，不要告诉他们必须装 AppImage。

### 社区端 5：Android Mobile（活跃源码 / UNVERIFIED）

APK 薄壳：WebView 加载官方 Web UI，内嵌 Node 跑官方 `@deepseek-ai/dsh`。既有第一方源码已恢复到本仓 [`apps/android`](../apps/android)，保持 `[UNVERIFIED]`，在 Android Reality Gate 通过前不写入 Published Latest 下载清单。

## 官方 Web 是伙伴入口，不是我们的产品

```text
                    DeepSeek Harness Runtime
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
          ▼                 ▼                  ▼
   Official Web       Community TUI      Community Desktop / experimental Mobile
   DeepSeek ships     we ship            shipped / Labs
                                         ├── Windows
                                         ├── macOS
                                         ├── Linux AppImage
                                         └── Android (active source, UNVERIFIED, not yet published)
```

正确说法：

> 一套官方 Runtime，五个 Community endpoints；前四个当前已发行，Android 为活跃源码 `[UNVERIFIED]` 端。与官方 Web 共用同一份 `~/.dsh`。

错误说法：

> 我们有 Web + Desktop + Terminal 三端。

这种说法会让人误以为 Community 发行了官方 Web。

## 对外口号

优先使用：

> **One Harness. Five community endpoints. Four shipped today; Android active / UNVERIFIED.**

> **一套 Harness，五个社区端：WSL/Linux 终端、Windows Desktop、macOS Desktop、Linux AppImage、Android；前四个已发行，Android 活跃源码仍待 Reality Gate。**

同时说明：

> 与官方 Web 共用官方 `~/.dsh` Session 存储。Official Web 不是 Community 发行端。

Android 是 Community endpoint，但在 `[UNVERIFIED]` 阶段不得计入当前已发行端数量；官方 Web 也不得误写成 Community 发行端。
