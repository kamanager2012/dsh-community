# Community endpoints

Official is the kernel; community is only a shell. This is the locked product-end
definition. Do not mix **OS targets**, **UI surfaces**, and **Community endpoints**.

[简体中文](community-endpoints.md) · [Getting started](getting-started.en.md) · [Online Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/en/)

## Three layers that are not the same thing

| Layer | Count | Meaning |
|---|---:|---|
| OS targets the code can build | 4 | Linux, Windows, macOS, Android |
| Community UI surfaces | 3 | Terminal / TUI, Desktop, Mobile shell |
| Community endpoints shipped to users | **5** | WSL/Linux Terminal, Windows Desktop, macOS Desktop, Linux AppImage, Android |

Official Web is an official DeepSeek surface. It shares `~/.dsh` with Community, but it
is **not** a Community endpoint.

## The five Community endpoints

```text
                    Official DeepSeek Harness Runtime
                                │
     ┌──────────┬───────────────┼───────────────┬──────────┐
     ▼          ▼               ▼               ▼          ▼
 WSL/Linux   Windows         macOS          Linux       Android
  Terminal   Desktop         Desktop        AppImage     Mobile
    ①          ②               ③              ④           ⑤
```

| # | Endpoint | Artifact | Maturity |
|---|---|---|---|
| 1 | WSL / Linux Terminal | `dsh-community` / `pnpm tui` | Stable (primary source path) |
| 2 | Windows Desktop | `DSH Community Setup.exe` | Stable (published Latest) |
| 3 | macOS Desktop | `dsh-community-*.dmg` | Stable (published Latest) |
| 4 | Linux Desktop AppImage | `dsh-community-*.AppImage` | Beta (Release artifact; CLI users still start at Terminal) |
| 5 | Android Mobile | APK (WebView + nodejs-mobile) | `[UNVERIFIED]` in Labs (`deepseek-harness-suite`) until Reality Gate |

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

### 2. Windows Desktop

For Windows users who should not have to install Node.js or a CLI first:

```text
DSH Community Setup.exe
→ install → API key → use
```

### 3. macOS Desktop

For macOS users on the same path:

```text
dsh-community-*.dmg
→ install → API key → use
```

### 4. Linux Desktop AppImage

For Linux users who want a graphical desktop without a Windows/macOS installer. This is
community endpoint 4, not an accidental build leftover. WSL / headless-server users still
start at the Terminal.

### 5. Android Mobile

A thin APK: WebView hosts official Web UI; embedded Node runs published
`@deepseek-ai/dsh`. Source currently lives in
[`deepseek-harness-suite/apps/android`](https://github.com/kamanager2012/deepseek-harness-suite).
It stays `[UNVERIFIED]` and off the `dsh-community` Latest download list until the Termux
Reality Gate passes.

## Official Web is an upstream companion

Correct claim:

> One official Runtime. Five Community endpoints. Same `~/.dsh` as official Web.

Incorrect claim:

> We have Web + Desktop + Terminal.

That wording makes people think Community ships the official Web surface.

## Slogan

Prefer:

> **One Harness. Five Community Endpoints.**

Chinese:

> **一套 Harness，五个社区端：WSL/Linux 终端、Windows 桌面、macOS 桌面、Linux AppImage、Android。**

Always add:

> Shares the official `~/.dsh` session store with official Web. Official Web is not a Community endpoint.

Do not use **One Harness. Three Surfaces.** or **Three Community Endpoints** as the current product slogan.
