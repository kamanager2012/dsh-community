# DeepSeek Harness Community Labs (DSH-Suite)

> Community Labs for DeepSeek Harness. Not a download channel.

**Do not install from this repository.** Releases live at [`dsh-community`](https://github.com/kamanager2012/dsh-community/releases/latest).

[简体中文](README.zh-CN.md) | **English**

[![Contract CI](https://github.com/kamanager2012/deepseek-harness-suite/actions/workflows/contract-ci.yml/badge.svg)](https://github.com/kamanager2012/deepseek-harness-suite/actions/workflows/contract-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Upstream Target: 0.1.0-rc.6](https://img.shields.io/badge/Official%20DSH-0.1.0--rc.6%20verified-green.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)

---

## Ecosystem position

This repository is **Community Labs**, not a second user-facing product and not a
download channel. It is where maintainers validate experimental Bridge, SDK
transport, security, checkpoint, audit, and TUI / Desktop ideas before a capability
can pass the Reality Gate and enter [`dsh-community`](https://github.com/kamanager2012/dsh-community)
as Canary, Preview, or Stable.

| Repository | Role | Link |
|---|---|---|
| [`dsh-community`](https://github.com/kamanager2012/dsh-community) | Canonical Product; the only normal download entry | [Latest](https://github.com/kamanager2012/dsh-community/releases/latest) · [current-release.json](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json) |
| [`deepseek-harness-handbook`](https://github.com/kamanager2012/deepseek-harness-handbook) | Knowledge, evidence, and operations | [Online handbook](https://kamanager2012.github.io/deepseek-harness-handbook/) |
| [`dsh-community-plugins`](https://github.com/kamanager2012/dsh-community-plugins) | Compatibility registry | [Catalog](https://github.com/kamanager2012/dsh-community-plugins) |
| [`dsh-marketplace`](https://github.com/kamanager2012/dsh-marketplace) | Discovery and install UX | [Repository](https://github.com/kamanager2012/dsh-marketplace) |
| [`dsh-community-edition`](https://github.com/kamanager2012/dsh-community-edition) | Merge & Archive | [Historical reference](https://github.com/kamanager2012/dsh-community-edition) |

The execution core is the official [DeepSeek Harness Runtime](https://github.com/deepseek-ai/deepseek-harness).
Labs must not reimplement its Agent loop, official Session persistence, tool
execution, or core packages.

For the current seam-by-seam handoff, read [docs/ECOSYSTEM_HANDOFF.md](docs/ECOSYSTEM_HANDOFF.md)
or the [English handoff](docs/ECOSYSTEM_HANDOFF.en.md). The evidence matrix is in the
[Reality Gate runbook](docs/reality-gate.en.md).

## Current evidence snapshot

| Gate | Status | Meaning |
|---|---|---|
| Code / build / unit / contract tests | GREEN | 34/34 tests passed, tsc -b clean. |
| Reality Gate adapter & failure-path tests | GREEN | Shell fail-closed, typed SessionEvent.data decoding, 5MB memory cap, ancestor symlink jail verified. |
| Upstream contract probe CI | GREEN | Verified in GitHub Actions CI (run 31934271278, 128 plugins observed). |
| Stdio JSON-RPC Wire Protocol E2E | GREEN | Hard assertion `executionMode === sdk_jsonrpc` with fallback disabled verified over line transport. |
| Shipped Profile Live Verification | `[PENDING_UPSTREAM]` | Awaiting official `@deepseek-ai/dsh` runtime package to ship standard stdio JSON-RPC profile out-of-the-box. |

## 🎯 Reality Gate & Implementation Status

| Capability / Module | Status | Architectural Invariant & Evidence |
| :--- | :--- | :--- |
| **Official Source Ownership** | `[REAL]` | `Ownership = 0`. Zero vendored code. Runtime launched via official `@deepseek-ai/dsh`. |
| **Desktop Web Shell** | `[REAL]` | Controlled Electron shell hosting official localhost runtime with tray & clean process lifecycle. |
| **Process Tree Governance** | `[REAL]` | POSIX process group detachment + Windows `taskkill /T /F` (0 orphan 3080 port leaks). |
| **Dynamic Contract CI** | `[PROBE]` | Introspection probe against `@deepseek-ai/dsh` CLI flags & plugin surface (128 plugins observed). |
| **TUI Visual Components** | `[REAL]` | `DiffViewer` (syntax highlighing), `ReasoningBox` (collapsible thought stream), `ToolCard`. |
| **Smart Risk Evaluator** | `[FAIL-CLOSED]` | `DshRiskEvaluator` enforces capability semantics; unknown tools fail closed (high risk / approval required). |
| **Runtime Execution Transport** | `[LABS / SDK-ADAPTER]` | `DshRuntimeClient` implements typed `SessionEvent.data` decoding & pre-enqueue replay guard; live JSON-RPC execution pending upstream profile. |
| **Interactive Tool Approval** | `[BLOCKED_BY_UPSTREAM]` | Client-side risk evaluation active; runtime server-to-client approval RPC pending upstream SDK support. |
| **Checkpoint & Workspace Jail** | `[WORKSPACE-JAIL]` | `DshCheckpointEngine` binds to `config.workspacePath`, enforces ancestor symlink containment, NUL/control byte filtering, and 5MB snapshot memory cap. |
| **Session Safety Gate** | `[READ-SAFE]` | Official `~/.dsh/sessions` is strictly **Read-Only** to prevent state corruption; Suite uses `~/.dsh/suite_sessions`. |
| **Diagnostics & Health** | `[REAL]` | `/doctor` executes five-layer system checks (Node version, process isolation, API keys, token budget). |
| **Tamper-Evident Audit** | `[REAL]` | `/audit` maintains a SHA-256 hash chain over approval decisions **and** individual tool invocations/results (start/end pairs with duration); persisted per session to `~/.dsh/suite_audit/<sessionId>.audit.jsonl`, resumed via verified `loadAndVerify` on restart. Disk failures surface as `writeFailures` without ever blocking execution. |
| **Rollback & Fork** | `[UI-LEVEL]` | `/message-rewind` and `/conversation-fork` (UI-level rewind until upstream exposes runtime checkpoint APIs). |

---

## 🌟 Product Architecture: One Harness. Four Community Endpoints.

```text
                         Official DeepSeek Harness Runtime
                                       │
                      (Shared ~/.dsh Single Session Truth)
                                       │
        ┌──────────────────────────────┼───────────────────────────────┐
        │                              │                               │
        ▼                              ▼                               ▼
  WSL / Linux                   Windows Desktop                 macOS Desktop
    Terminal                  (DSH Community Setup)          (DSH Community .dmg)
(Developer / CLI)            (Download → Install → Run)      (Download → Install → Run)
        │                              │                               │
        │                              ▼                               │
        │                       Android Mobile                        │
        │                   (WebView + nodejs-mobile)                 │
        │                      `[UNVERIFIED]`                          │
        └──────────────────────────────┴───────────────────────────────┘
                                       │
                      Canonical Distribution: dsh-community
```

* **Official Web**: Upstream companion interface sharing the same `~/.dsh` session store.
* **Linux AppImage**: Secondary / headless build artifact (WSL/Linux Terminal is the primary Linux user path).
* **Android**: fourth community endpoint, APK shell over the official runtime; `[UNVERIFIED]` until the Termux verification (`scripts/termux-verify.sh`) passes — see [`docs/android-endpoint.md`](./docs/android-endpoint.md).

---

## 📦 Packages & Distribution

| Package | Role | Status |
| :--- | :--- | :--- |
| [`@dsh-community/dsh-bridge`](./packages/dsh-bridge) | Anti-Corruption Layer, Runtime Client & Process Supervisor | `[PARTIAL]` / Labs; not published to npm `latest` |
| [`@dsh-community/tui`](./apps/tui) | Terminal UX (Ink / Yoga) | `[LABS]`; not published to npm `latest` |
| [`@dsh-community/desktop`](./apps/desktop) | Desktop Shell (Electron + Subprocess Manager) | `[LABS]` |
| [`dsh-android`](./apps/android) | Android APK Shell (WebView + nodejs-mobile) | `[UNVERIFIED]` |

---

## 🚀 Terminal Commands (TUI)

- `/doctor` - Run five-layer environment & health diagnostics
- `/plugins [search]` - Discover verified plugins from the community registry
- `/audit` - Inspect cryptographic SHA-256 tamper-evident execution log
- `/provider [switch <id>]` - Inspect or switch model provider (DeepSeek, SiliconFlow, Ollama, vLLM, Ark)
- `/undo` - Roll back the latest file modification checkpoint
- `/export [markdown|json]` - Export structured session report with thought process
- `/sessions` - Discover sessions (Official + Suite)
- `/resume <id>` - Resume previous session
- `/save` - Save current session atomically to `~/.dsh/suite_sessions/`
- `/rollback [index]` - Message history rewind
- `/fork` - Branch conversation from current turn
- `Esc` - Interrupt current thought / turn generation

---

## 🛠️ Development & Dynamic Contract Testing

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm run build

# Run unit & contract tests
pnpm run test

# Run LIVE dynamic probe against official @deepseek-ai/dsh
npx tsx scripts/contract-checker.ts
```

---

## 📄 License
MIT © 2026 DeepSeek Harness Community Team
