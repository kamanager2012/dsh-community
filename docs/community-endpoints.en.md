# Community endpoints

This is the locked product-end definition. Do not mix **OS targets**, **UI surfaces**,
and **Community endpoints**.

[简体中文](community-endpoints.md) · [Getting started](getting-started.en.md) · [Online Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/en/)

## Three layers that are not the same thing

| Layer | Count | Meaning |
|---|---:|---|
| OS targets the code can build | 3 | Linux, Windows, macOS |
| Community UI surfaces | 2 | Terminal / TUI, Desktop |
| Community endpoints shipped to users | **3** | WSL/Linux Terminal, Windows Desktop, macOS Desktop |

Official Web is an official DeepSeek surface. It shares `~/.dsh` with Community, but it
is **not** a Community endpoint. The Linux AppImage is a **secondary artifact**, not a
fourth product end.

## The three Community endpoints

```text
                    Official DeepSeek Harness Runtime
                                │
               ┌────────────────┼────────────────┐
               │                │                │
               ▼                ▼                ▼
        WSL / Linux TUI    Windows Desktop   macOS Desktop
         dsh-community        Setup.exe            dmg
```

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

This is the primary Linux product path. A Linux Desktop AppImage is not required for
this user.

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

## Official Web is an upstream companion

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

Correct claim:

> One official Runtime. Three Community endpoints. Same `~/.dsh` as official Web.

Incorrect claim:

> We have Web + Desktop + Terminal.

That wording makes people think Community ships the official Web surface.

## Linux AppImage

Release workflows may still attach `dsh-community-*.AppImage`. Treat it as optional /
secondary:

- do not list it as a primary Community endpoint;
- do not tell WSL users they need a Linux Desktop;
- do not count it as a fourth product end.

The Linux user path is the Terminal.

## Slogan

Prefer:

> **One Harness. Three Community Endpoints.**

Chinese:

> **一套 Harness，三个社区端：WSL/Linux 终端、Windows 桌面、macOS 桌面。**

Always add:

> Shares the official `~/.dsh` session store with official Web.

Do not use **One Harness. Three Surfaces.** as the product slogan. It mixes an official
surface into the Community product count.
