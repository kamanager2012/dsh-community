# Community 端定义

这是已经锁定的产品端定义。不要混淆 **操作系统目标**、**UI 形态** 和 **社区端**。

[English](community-endpoints.en.md) · [中文使用指南](getting-started.md) · [在线 Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/)

## 三个不能混为一谈的层次

| 层次 | 数量 | 含义 |
|---|---:|---|
| 代码可以构建的 OS 目标 | 3 | Linux、Windows、macOS |
| Community UI 形态 | 2 | Terminal / TUI、Desktop |
| 我们发行给用户的社区端 | **3** | WSL/Linux 终端、Windows 桌面、macOS 桌面 |

官方 Web 是 DeepSeek 官方界面。它与 Community 共享 `~/.dsh`，但**不是社区端**。

Linux AppImage 是**次要构建产物**，不是第四个产品端。

## 三个 Community 端

```text
                    Official DeepSeek Harness Runtime
                                │
               ┌────────────────┼────────────────┐
               │                │                │
               ▼                ▼                ▼
        WSL / Linux TUI    Windows Desktop   macOS Desktop
         dsh-community        Setup.exe            dmg
```

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

这是 Linux 的主产品路径。此类用户不需要 Linux Desktop AppImage。

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

## 官方 Web 是伙伴入口，不是我们的产品

```text
                    DeepSeek Harness Runtime
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
          ▼                 ▼                  ▼
   Official Web       Community TUI      Community Desktop
   DeepSeek ships     we ship            we ship
                                         ├── Windows
                                         └── macOS
```

正确说法：

> 一套官方 Runtime，三个 Community 端；与官方 Web 共用同一份 `~/.dsh`。

错误说法：

> 我们有 Web + Desktop + Terminal 三端。

这种说法会让人误以为 Community 发行了官方 Web。

## Linux AppImage 的定位

Release workflows may still attach:

```text
dsh-community-*.AppImage
```

它只能按可选/次要产物处理：

- 不要把它列为主要 Community 端；
- 不要告诉 WSL 用户必须安装 Linux Desktop；
- 不要把它算作第四个产品端。

Linux 用户主路径是 Terminal。

## 对外口号

优先使用：

> **One Harness. Three Community Endpoints.**

> **一套 Harness，三个社区端：WSL/Linux 终端、Windows 桌面、macOS 桌面。**

同时说明：

> 与官方 Web 共用官方 `~/.dsh` Session 存储。

不要再把 **One Harness. Three Surfaces.** 当作产品口号。它把官方 Web、Community TUI 和 Community Desktop 混在一起，会把官方界面错误计入我们的产品端数量。
