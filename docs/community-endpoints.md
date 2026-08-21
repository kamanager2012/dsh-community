# Community 端定义

这是已经锁定的产品端定义。不要混淆 **操作系统目标**、**UI 形态** 和 **社区端**。

[English](community-endpoints.en.md) · [中文使用指南](getting-started.md) · [在线 Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/)

## 三个不能混为一谈的层次

| 层次 | 数量 | 含义 |
|---|---:|---|
| 代码可以构建的 OS 目标 | 4 | Linux、Windows、macOS、Android |
| Community UI 形态 | 3 | Terminal / TUI、Desktop、Mobile 壳 |
| 我们发行给用户的社区端 | **5** | WSL/Linux 终端、Windows 桌面、macOS 桌面、Linux AppImage、Android |

官方 Web 是 DeepSeek 官方界面。它与 Community 共享 `~/.dsh`，但**不是社区端**。

## 五个 Community 端

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
| 5 | Android 移动端 | APK（WebView + nodejs-mobile） | `[UNVERIFIED]`，当前在 Labs（`deepseek-harness-suite`）孵化，未过 Reality Gate 前不进正式下载页 |

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

面向需要图形桌面、但不走 Windows/macOS 安装包的 Linux 用户。它是正式第五套客户端里的第 4 端，不是“随便附带的构建垃圾”。

同时：WSL / 无桌面服务器用户的默认路径仍是终端，不要告诉他们必须装 AppImage。

### 5. Android 移动端

APK 薄壳：WebView 加载官方 Web UI，内嵌 Node 跑官方 `@deepseek-ai/dsh`。源码目前在 [`deepseek-harness-suite/apps/android`](https://github.com/kamanager2012/deepseek-harness-suite)，通过 Termux Reality Gate 之前保持 `[UNVERIFIED]`，不写入 `dsh-community` Latest 下载清单。

## 官方 Web 是伙伴入口，不是我们的产品

```text
                    DeepSeek Harness Runtime
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
          ▼                 ▼                  ▼
   Official Web       Community TUI      Community Desktop / Mobile
   DeepSeek ships     we ship            we ship
                                         ├── Windows
                                         ├── macOS
                                         ├── Linux AppImage
                                         └── Android (Labs)
```

正确说法：

> 一套官方 Runtime，五个 Community 端；与官方 Web 共用同一份 `~/.dsh`。

错误说法：

> 我们有 Web + Desktop + Terminal 三端。

这种说法会让人误以为 Community 发行了官方 Web。

## 对外口号

优先使用：

> **One Harness. Five Community Endpoints.**

> **一套 Harness，五个社区端：WSL/Linux 终端、Windows 桌面、macOS 桌面、Linux AppImage、Android。**

同时说明：

> 与官方 Web 共用官方 `~/.dsh` Session 存储。Official Web 不是 Community 发行端。

不要再把 **One Harness. Three Surfaces.** 或 **Three Community Endpoints** 当作当前产品口号。
