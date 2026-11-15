# DSH Community

**简体中文** | [English](README.en.md)

[![CI](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml)
[![Published Latest](https://img.shields.io/github/v/release/kamanager2012/dsh-community?include_prereleases&label=Published%20Latest)](https://github.com/kamanager2012/dsh-community/releases/latest)
[![Official Core](https://img.shields.io/badge/Official%20Core-%40deepseek--ai%2Fdsh-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **你在官方 Web 或官方 Win/macOS Desktop 开的对话，在 Linux 终端、Linux AppImage 或 Android 手机上无缝接着聊 — 还能通过端到端加密统一远程操控 DSH、Claude Code、Codex CLI 与 OpenCode。**  
> 官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）的**不 vendor 官方源码、官方互补社区发行版**：100% 共用 `~/.dsh` 会话真源，不重复建设官方已有端，绝不重写第二套 Agent 循环。

## 核心亮点

- **官方与社区共享同一个 `~/.dsh`，补齐上游缺失的三个互补社区端** — 官方上游提供唯一执行内核、Official Web 及 Windows / macOS Desktop（`win-x64`、`mac-arm64`、`mac-x64`）；本仓专注于上游未提供的 **3 个互补 Community endpoints**：**WSL/Linux 终端（TUI）**、**Linux 桌面 AppImage** 与 **Android Remote Client APK**（`dsh-community-*-android-arm64-v8a.apk` 已在 [Published Latest](https://github.com/kamanager2012/dsh-community/releases/latest) 正式发布；已通过 CI `x86_64` 模拟器 E2EE 全链路验收，物理 `arm64-v8a` 真机遥测保持 `[UNVERIFIED]`）。
- **多 Agent（Multi-Agent）端到端加密远程控制面（`packages/remote-adapter`）** — 支持用 Android 已签名 APK 或浏览器 PWA 通过 Noise IK 端到端加密、局域网 mDNS、WebRTC P2P 或自部署盲中继（[`deploy/relay/`](deploy/relay/)）远程操控 **DSH、Claude Code、Codex CLI 与 OpenCode ACP**（`dsh-community remote start --engines claude,codex,opencode --qr`），并内置受限只读 Git diff 审查。
- **供应链可核验的 12 资产发行与插件兼容层** — 每次 Release 同时交付 Linux `.AppImage`、Android `arm64-v8a` `.apk` 与官方运行时 CycloneDX SBOM，并附带 SHA-256 与 Keyless Cosign `.sigstore.json` 签名包；[`packages/marketplace/catalog.json`](packages/marketplace/catalog.json) 记录实际 `testedDsh`、完整性摘要与权限披露（安装仍走官方 `dsh plugin add` 链）。

---

## 为什么选择 DSH Community？

先说清楚官方有什么（依据上游 `deepseek-ai/deepseek-harness` 源码，核对于 2026-11-15）：

| 官方提供 | 说明 |
|---|---|
| Web UI | `npx @deepseek-ai/dsh web`；经反向代理加启动 token 可被其他机器的浏览器访问 |
| Windows / macOS 桌面端 | Electron 壳（`win-x64`、`mac-arm64`、`mac-x64`）；官方打包文档明确 **Linux 不是受支持的 Desktop 发布目标** |
| `dsh` 启动器 | 按 profile 启动 `web` / `headless` / `sdk` / `acp`；**自身不带终端界面**，上游也没有 TUI 包 |
| Python SDK、ACP server | 供程序化调用，不是交互界面 |

这些空白，以及围绕官方内核的其他需求，已有几个第三方项目在做。以下对比只取自各项目自己的 README 与发布页（星数为 2026-11-15 当日数据）：

| 项目 | 做什么 | 许可 | Stars |
|---|---|---|---|
| [`ccch1mneyyy/dsh-Go`](https://github.com/ccch1mneyyy/dsh-Go) | Flutter 写的 Android 客户端：手机内置 Ubuntu + Node + DSH 本机运行（最新 APK 约 231 MB，另需约 1 GB 运行环境），或经 SSH / DSHarness Remote 遥控电脑；另有手机操控、桌宠、插件原生界面 | AGPL-3.0 | 23,280 |
| [`liguobao/ds-harness-remote`](https://github.com/liguobao/ds-harness-remote) | 官方插件形态的端到端加密 P2P 远程访问（TURN / 中继回退）；经 ACP 接入 DSH、Codex、Cursor、Antigravity、OpenCode、Claude Code 等；Android、Web、iOS（beta）客户端 | MIT | 2,941 |
| [`ccch1mneyyy/dsh-TUI`](https://github.com/ccch1mneyyy/dsh-TUI) | 第三方终端 UI 插件，功能丰富的 TUI | MIT | 7,735 |
| **DSH Community（本仓）** | Linux / WSL 终端界面、签名 Linux AppImage、不内置运行时的 Android 遥控端、多 Agent E2EE 远程控制面 | MIT | 0 |

**我们能核实的差异：**

- **补官方的 Linux 空白**：WSL/Linux 终端界面，以及签名的 Linux `.AppImage`。上述三个第三方项目的 README 均未提供 Linux 桌面安装包。
- **不改官方内核**：不 vendor、不 `patch-package`，Session 与官方共用 `~/.dsh`；终端界面是自研的 `packages/tui`，不挂载第三方 TUI。
- **发布物可验签**：每个 Release 的 12 个资产都带 SHA-256、Keyless Cosign `.sigstore.json`，并附官方运行时 CycloneDX SBOM；APK 另有 v2/v3 签名。dsh-Go 最新 Release 只提供 APK 与 `SHA256SUMS`。
- **自托管、体积小**：盲中继可自部署（[`deploy/relay/`](deploy/relay/)），不依赖托管服务；Android 客户端约 13 MB，不内置 Node 或 DSH。

**同样要说清楚的短板：**

- 项目很新（0 star），社区规模、文档与打磨程度都远不及上面三个项目。
- Android 只经过 CI `x86_64` 模拟器 E2EE 验收，物理 `arm64-v8a` 真机仍是 `[UNVERIFIED]`；没有 iOS。
- 想在**手机上直接运行 DSH**或使用**手机操控**，请用 dsh-Go；想要 **iOS、托管 Web 客户端或更多 Agent（如 Cursor）**，请看 DSHarness Remote；想要功能更丰富的终端 UI，请看 dsh-TUI。我们的多 Agent 目前只覆盖 DSH、Claude Code、Codex CLI、OpenCode。

---

## 快速开始

### 1. 下载已签名的 Linux AppImage 或 Android APK

在 [`releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest) 获取最新 `.AppImage`（Linux 桌面端）或 `-android-arm64-v8a.apk`（Android 8.0+ `arm64-v8a` 手机端，精确文件名与校验见 [`docs/current-release.json`](docs/current-release.json)）：

```sh
# Linux 桌面 AppImage：
chmod +x dsh-community-*.AppImage
sha256sum -c dsh-community-*.AppImage.sha256
./dsh-community-*.AppImage

# Android Remote Client APK（校验 SHA-256 后安装到手机）：
sha256sum -c dsh-community-*-android-arm64-v8a.apk.sha256
adb install dsh-community-*-android-arm64-v8a.apk
```

Cosign 无密钥验签方法见 [`docs/release.md#artifact-signing-keyless`](docs/release.md#artifact-signing-keyless) · 当前版本事实索引：[`docs/current-release.md`](docs/current-release.md)。

### 2. 从源码运行（WSL/Linux 终端、Linux 桌面或多 Agent 远程）

环境要求：Node.js 24.9+（官方 `@deepseek-ai/dsh@0.2.2-rc.3` 声明 `engines.node >=24.9.0`；本仓工作区最低要求 22.15，CI 在 Node 22 上通过）、pnpm，以及 `DEEPSEEK_API_KEY`（DSH / 混合模式）或本地 `PATH` 中的 **Claude Code / Codex CLI / OpenCode**（独立多 Agent 远程控制面模式）。官方 `0.1.0-rc.8` 起 session JSONL 使用了 Node 22.15 才提供的 `node:zlib` zstd API。对话与官方共用 `~/.dsh`。

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
export DEEPSEEK_API_KEY=...

pnpm start              # 有对话就接着最近一条，否则开新的
pnpm new                # 强制开新对话
pnpm sessions           # 查看本地会话历史
pnpm plugins            # 查看已安装插件
pnpm desktop            # 启动桌面壳（含社区市场页与远程二维码页）
pnpm marketplace -- list  # 插件发现 CLI
pnpm run doctor         # 自检（不要裸跑 pnpm doctor，那是 pnpm 自己的）

# 多 Agent E2EE 远程控制面：
# 1) 先构建一次，再本地托管浏览器 PWA 与单端口盲中继网关
pnpm build
pnpm start -- remote gateway --serve-web --port 8787 &
# 2) 启动远程宿主（--web-url 输出浏览器配对二维码；局域网/Android 客户端可追加 --host <LAN-IP> --mdns）
pnpm start -- remote start --engines claude,codex,opencode \
  --relay-url ws://127.0.0.1:8787/relay \
  --signaling-url ws://127.0.0.1:8787/signal \
  --web-url http://127.0.0.1:8787/app/ --qr
```

跨设备 / 手机通过 HTTPS 配对 PWA 或使用 Android APK 扫描 `dsh-remote://pair` 二维码时，请按 [`deploy/relay/README.md`](deploy/relay/README.md) 配置 TLS 反向代理并参见 [`docs/remote-host-client.md`](docs/remote-host-client.md)。

同一入口也叫 `dsh-community`（`dsh-community-tui` 仍可用），支持子命令：`new`、`resume last`、`sessions`、`doctor`、`version`、`plugins`（只读目录；安装仍走官方 `dsh plugin add` / 桌面市场页）、`desktop`、`remote`。

本地打包 Linux 解包目录或 AppImage（预览，未签名）：

```sh
pnpm desktop:package
./apps/desktop/release/linux-unpacked/dsh-community

pnpm desktop:package -- --appimage
```

---

## 互补端边界与双状态事实

> **One Harness. Three complementary community endpoints — all published in Latest; Android physical `arm64-v8a` handset telemetry remains `[UNVERIFIED]`.**  
> Runtime / Session / 插件执行及官方 Web、Win/macOS Desktop 归官方内核上游所有；历史版本 `v0.1.1-rc.2` 之后已退役 Win/macOS 安装包（`--win` / `--mac` fail-closed），`v0.1.2`–`v0.1.6` 仅作历史记录。

> 命名红线：不叫 dsh-TUI / DeepSeek Harness Desktop（那是别人的产品名），不在 npm 冒用 `@deepseek-ai` 或 `dsh-tui` 的包名；不要 `npm publish` 本仓的 workspace 包。

| 发行面 | 归属 | 入口 |
|---|---|---|
| 官方 Web & Win/macOS Desktop | 官方上游既有端，不是 Community 互补端 | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（`npx @deepseek-ai/dsh web`） |
| WSL/Linux 终端 | **互补社区端 1：Terminal / TUI（已发行）** | `dsh-community` / `dsh-community-tui` / `pnpm tui` |
| Linux AppImage | **互补社区端 2：Linux Desktop（已发行）** | [Published Latest](https://github.com/kamanager2012/dsh-community/releases/latest) `.AppImage` |
| Android Remote Client | **互补社区端 3：Remote Mobile（已发行 APK；真机遥测 `[UNVERIFIED]`）** | [Published Latest](https://github.com/kamanager2012/dsh-community/releases/latest) `-android-arm64-v8a.apk`（`apps/android` + `packages/remote-adapter`，[架构说明](docs/remote-host-client.md)） |
| 多 Agent 远程控制面 | 社区远程控制层（`packages/remote-adapter`） | `dsh-community remote start --qr` 或桌面「远程」标签页 |
| 已验证能装的社区插件 | 兼容性目录（不是 awesome 目录） | 桌面市场页 · `pnpm marketplace` · [`packages/marketplace/catalog.json`](packages/marketplace/catalog.json) |
| 中文/英文工程手册 | 知识 / 证据与 AI 检索库 | [在线手册站](https://kamanager2012.github.io/dsh-community/) · [`handbook/`](handbook/) |

**Candidate Source 与 Published Latest 是两条独立状态。**  
源码可以先升级到新的官方候选版本，而 GitHub Latest、已发布安装包、插件 `testedDsh` 和真实 User-Loop 证据继续停留在上一个已验证版本。不要从 `releases/latest` 的版本号反推当前 workspace 版本，也不要从源码候选版本伪造尚未发布的安装包。

| 状态 | 去哪看 |
|---|---|
| **Published Latest** | [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest)；真实 tag、安装包名、release/asset 证据以 [`docs/current-release.json`](docs/current-release.json) 为准 |
| **Candidate Source** | 当前源码候选的 `candidateTag`、官方 core pin（`packages/dsh-bridge/src/pin.ts`）、workspace 产品号与 Dual-Badge 以 [`docs/current-release.json`](docs/current-release.json) 为准（`latest-tested.json` 只是契约兼容性推荐，不是 pin 真源） |
| **Historical / Pre-release** | [Releases](https://github.com/kamanager2012/dsh-community/releases) |

三个互补社区端的详细定义与入门请见：[使用指南](docs/getting-started.md) · [发行端与实验端定义](docs/community-endpoints.md) · [当前发行说明](docs/current-release.md)。

---

## 硬边界与成功标准

| 做 | 不做 |
|---|---|
| 依赖已发布的 `@deepseek-ai/dsh` | 不 vendor 官方 `packages/*`（Official Source Ownership = 0） |
| Desktop 子进程启动 `dsh web`，只管理生命周期 | 不把 stdout 解析成业务协议，不 `patch-package` 改官方 UI |
| 默认共用官方 `~/.dsh` session 真源 | 不把 DSH 数据迁进 Desktop AppData |
| 我们的 TUI 自己组合、自己列官方 session | 不把参考 TUI 当上游，不维护第二套 session log |
| `contracts/` 快照官方表面 | 不维护一套社区 `event-types.ts` |

1. 官方源代码 vendor = 0
2. TUI 对官方 Cordis row 的覆盖数量显著下降（33 → 15 → 8 → 只剩 TUI 自己的 insert）
3. TUI/Desktop/Android 不实现 Agent loop、Session persistence、Tool execution
4. 一次 upstream rc bump，业务 UI 原则上零修改
5. WSL/Linux TUI、Linux AppImage、Android Remote Client 与官方 Web/Desktop 能共享同一 Session 真源（`~/.dsh`）
6. 新版本兼容问题首先在 contract CI 爆

当前：1 / 3 / 5 按设计成立；2 社区 overlay 只改官方行，不挂第三方 TUI；第 4 条持续按上游新包做回归。

---

## 生态地图与仓库布局

本仓是**唯一用户下载入口**。原独立仓库 `dsh-marketplace`、`dsh-community-plugins`、`dsh-community-edition` 与 `deepseek-harness-suite` 已于 2026-09-13 并入本仓后删除：

```text
contracts/              官方表面快照 + compatibility matrix
packages/dsh-bridge     解析官方 bin、生命周期、数据目录
packages/marketplace    插件发现 CLI + catalog.json
packages/remote-adapter 多 Agent E2EE 远程控制面（DSH / Claude Code / Codex CLI / OpenCode ACP + 只读 Git diff 审查），支持 Noise IK 与 LAN/WebRTC/Relay
packages/tui            社区终端界面库（@dsh-community/tui-surface，基于 Ink）
packages/tui-adapter    我们的 TUI 薄 patch + KPI
packages/shared-types   社区自己的类型，不是官方 event fork
apps/desktop            官方 `dsh web` Electron 壳 + 官方 session 列表 + 市场/远程界面
apps/remote-web         浏览器端 E2EE 远程控制 PWA
apps/android            Android Remote Client（已发行 arm64-v8a APK；CI x86_64 模拟器 E2EE PASS，物理真机遥测 [UNVERIFIED]）
apps/tui                官方 `dsh --profile` / `--resume` 启动器（dsh-community）
deploy/                 自部署盲中继部署配置（deploy/relay/）
handbook/               中英文工程手册（mkdocs）与 AI 检索目录
archive/                已归档历史 Labs（archive/deepseek-harness-suite/，不进构建与 CI）
tests/upstream-contract vendor=0、pin、CLI 与发行契约检查
```

延伸文档：[Architecture](ARCHITECTURE.md) · [ECOSYSTEM.md](ECOSYSTEM.md) · [发布指南](docs/release.md) · [Remote Host-Client](docs/remote-host-client.md) · [重构说明](docs/reconstruction.md) · [Upgrade](docs/upgrade.md) · [TUI adapter](docs/tui-adapter.md) · [contracts](contracts/README.md) · [Version Manager](docs/version-manager.md)。

## Security

见 [SECURITY.md](SECURITY.md)：Desktop 的 Electron 加固边界（`contextIsolation` / 权限默认拒绝 / 导航白名单）、cosign keyless 发行签名的验证方法、`~/.dsh` 会话数据共享范围，以及如何私下报告安全问题。

## Community & License

[Contributing](CONTRIBUTING.md) · [Governance](GOVERNANCE.md) · [Community Conduct](CODE_OF_CONDUCT.md) · [Support](SUPPORT.md) · [Security](SECURITY.md)

MIT。运行时版权与第三方声明见 [NOTICE](NOTICE) 和官方 `@deepseek-ai/dsh` 包元数据。
