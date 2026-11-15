# DSH Community

[English](README.md) | **简体中文**

[![CI](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml)
[![Published Latest](https://img.shields.io/github/v/release/kamanager2012/dsh-community?include_prereleases&label=Published%20Latest)](https://github.com/kamanager2012/dsh-community/releases/latest)
[![Official Core](https://img.shields.io/badge/Official%20Core-%40deepseek--ai%2Fdsh-blue)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **你在官方 Web 或官方 Win/macOS Desktop 开的对话，在 Linux 终端或 Linux AppImage 接着聊 — 还可通过端到端加密远程控制多个 Coding Agent。**  
> 官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`）的**不 vendor 官方源码、官方互补社区发行版**：100% 共用 `~/.dsh` 会话真源，不重复建设官方已有端，绝不重写第二套 Agent 循环。

## 核心亮点

- **官方与社区共享同一个 `~/.dsh`** — 官方上游提供唯一执行内核、Official Web 及 Windows / macOS Desktop（`win-x64`、`mac-arm64`、`mac-x64`）；本仓专注于上游缺失的 **3 个互补 Community endpoints**：**WSL/Linux 终端（TUI）**、**Linux 桌面 AppImage** 与 **Android Remote Client**（`apps/android`，开发中 / `[UNVERIFIED]`，尚未进入 Published Latest）。
- **多 Agent 端到端加密远程控制面（`packages/remote-adapter`）** — 支持用浏览器 PWA 或移动端界面通过 Noise IK 端到端加密、局域网 mDNS、WebRTC P2P 或自部署盲中继（[`deploy/relay/`](deploy/relay/)）远程操控 **DSH、Claude Code、Codex CLI 与 OpenCode ACP**（`dsh-community remote start --engines claude,codex,opencode --qr`），并内置只读 Git diff 审查。
- **供应链可核验的发行与插件兼容层** — Linux AppImage 发行产物附带 SHA-256、Keyless Cosign `.sigstore.json` 签名包与官方运行时 CycloneDX SBOM；[`packages/marketplace/catalog.json`](packages/marketplace/catalog.json) 记录实际 `testedDsh`、完整性摘要与权限披露（安装仍走官方 `dsh plugin add` 链）。

---

## 快速开始

### 1. 下载 Linux AppImage（Linux 图形桌面推荐）

在 [`releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest) 获取最新 `.AppImage`（精确文件名与校验见 [`docs/current-release.json`](docs/current-release.json)）：

```sh
chmod +x dsh-community-*.AppImage
sha256sum -c dsh-community-*.AppImage.sha256
./dsh-community-*.AppImage
```

Cosign 无密钥验签方法见 [`docs/release.md#artifact-signing-keyless`](docs/release.md#artifact-signing-keyless) · 当前版本事实索引：[`docs/current-release.md`](docs/current-release.md)。

### 2. 从源码运行（WSL/Linux 终端、Linux 桌面或多 Agent 远程）

环境要求：Node.js 22.15+、pnpm，以及 `DEEPSEEK_API_KEY`（DSH / 混合模式）或本地 `PATH` 中的 **Claude Code / Codex CLI / OpenCode**（独立多 Agent 远程控制面模式）。官方 `0.1.0-rc.8` 起 session JSONL 使用了 Node 22.15 才提供的 `node:zlib` zstd API。对话与官方共用 `~/.dsh`。

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
# 2) 启动远程宿主（--web-url 输出浏览器配对二维码；局域网/原生客户端可追加 --host <LAN-IP> --mdns）
pnpm start -- remote start --engines claude,codex,opencode \
  --relay-url ws://127.0.0.1:8787/relay \
  --signaling-url ws://127.0.0.1:8787/signal \
  --web-url http://127.0.0.1:8787/app/ --qr
```

跨设备 / 手机浏览器通过 HTTPS 配对 PWA 时，请按 [`deploy/relay/README.md`](deploy/relay/README.md) 配置 TLS 反向代理并传 `https://.../app/`，完整参数见 [`docs/remote-host-client.md`](docs/remote-host-client.md)（不配 `--web-url` 时默认仅监听 `127.0.0.1` 并输出 `dsh-remote://pair` 二维码）。

同一入口也叫 `dsh-community`（`dsh-community-tui` 仍可用），支持子命令：`new`、`resume last`、`sessions`、`doctor`、`version`、`plugins`（只读目录；安装仍走官方 `dsh plugin add` / 桌面市场页）、`desktop`、`remote`。

本地打包 Linux 解包目录或 AppImage（预览，未签名）：

```sh
pnpm desktop:package
./apps/desktop/release/linux-unpacked/dsh-community

pnpm desktop:package -- --appimage
```

---

## 互补端边界与双状态事实

> **One Harness. Three complementary community endpoints. Two shipped today; Android active / UNVERIFIED.**  
> Runtime / Session / 插件执行及官方 Web、Win/macOS Desktop 归官方内核上游所有；历史版本 `v0.1.1-rc.2` 之后已退役 Win/macOS 安装包（`--win` / `--mac` fail-closed），`v0.1.2`–`v0.1.6` 仅作历史记录。

> 命名红线：不叫 dsh-TUI / DeepSeek Harness Desktop（那是别人的产品名），不在 npm 冒用 `@deepseek-ai` 或 `dsh-tui` 的包名；不要 `npm publish` 本仓的 workspace 包。

| 发行面 | 归属 | 入口 |
|---|---|---|
| 官方 Web & Win/macOS Desktop | 官方上游既有端，不是 Community 互补端 | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness)（`npx @deepseek-ai/dsh web`） |
| WSL/Linux 终端 | **互补社区端 1：Terminal / TUI（已发行）** | `dsh-community` / `dsh-community-tui` / `pnpm tui` |
| Linux AppImage | **互补社区端 2：Linux Desktop（已发行）** | [Published Latest](https://github.com/kamanager2012/dsh-community/releases/latest) `.AppImage` |
| Android | **互补社区端 3：Remote Mobile（活跃源码，`[UNVERIFIED]`）** | `apps/android` + `packages/remote-adapter`（[架构说明](docs/remote-host-client.md)） |
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
3. TUI/Desktop 不实现 Agent loop、Session persistence、Tool execution
4. 一次 upstream rc bump，业务 UI 原则上零修改
5. WSL/Linux TUI、Linux AppImage 与官方 Web/Desktop 能共享同一 `~/.dsh` Session 真源
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
apps/android            Android Remote Client（[LABS]/[UNVERIFIED]；不进 Published Latest）
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
