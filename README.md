# dsh-community

**DeepSeek Harness 的社区发行、兼容性与安全验证层。**

官方 DeepSeek Harness 是唯一执行内核。本仓不重写 Agent Runtime，而是在已发布的 `@deepseek-ai/dsh` 周围维护四件事：**精确上游版本与契约跟踪、跨平台社区发行、第三方插件兼容性注册表、发行与插件安全证据**。

当前实际发行入口是 **4 个**：WSL/Linux 终端、Windows Desktop、macOS Desktop、Linux AppImage。Android 仅保留为已归档 Labs 中的 **[UNVERIFIED] 实验原型**，不属于 Latest 下载。所有已发行入口默认共享官方 Runtime、官方插件链和同一个 `~/.dsh` Session 真源。

你今天在官方 Web 开的对话，关掉以后用 `dsh-community` 终端可以接着聊；再打开 Desktop，仍然是同一条会话。

> **One Harness. Four shipped community endpoints.** Runtime / Session / 插件事实仍归官方内核所有；社区层只维护发行、UX、兼容性与验证，不 vendor 官方源码，不另建第二套 Agent loop 或 Session store。

本仓的 Compatibility Registry 不是 awesome-list：第三方插件条目记录实际 `testedDsh` 版本、包完整性以及 network / data egress / credentials / filesystem / process / persistence 等结构化安全元数据；安装仍走官方 `dsh plugin add` 链。

[English](README.en.md) | 简体中文

[![ci](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml)

| 通道 | 去哪下 |
|---|---|
| **当前发行** | [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest)（`v0.1.1-rc.2`） |
| **历史 / Pre-release** | [Releases](https://github.com/kamanager2012/dsh-community/releases) 里旧的独立编号 |

当前 Latest、官方内核、四个已发行入口、Android 实验状态、安装包文件名和证据标签以 [current-release](docs/current-release.md) / [`current-release.json`](docs/current-release.json) 为准。版本规则见 [Version policy](docs/version-policy.md)。

当前发行 **v0.1.1-rc.2**：根目录、Desktop、TUI、workspace 包全部同号，1:1 镜像官方核心 `@deepseek-ai/dsh@0.1.1-rc.2`；契约面与 rc.1 一致（135 行配置树零漂移）。发行产物带 keyless cosign 签名（`.sigstore.json`），验证方法见 [release 文档](docs/release.md#artifact-signing-keyless)。

Desktop 与 TUI 的身份应显示为：`DeepSeek Harness Community v0.1.1-rc.2 [Official Core: @deepseek-ai/dsh@0.1.1-rc.2]`。

| 发行面 | 命名 | 入口 |
|---|---|---|
| 官方 Web | 官方上游兼容入口，不是 Community 发行端 | [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) |
| WSL/Linux 终端 | **社区端 1：Terminal / TUI** | `dsh-community` / `dsh-community-tui` / `pnpm tui` |
| Windows 桌面 | **社区端 2：Desktop** | [Latest `v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest) Setup.exe，或 `pnpm desktop` |
| macOS 桌面 | **社区端 3：Desktop** | [Latest `v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest) dmg，或 `pnpm desktop` |
| Linux AppImage | **社区端 4：Desktop** | 随 Release 附带；CLI 用户仍以终端为主 |
| Android | **实验性 Mobile（非当前发行）** | `[UNVERIFIED]`；原型在已归档的 Labs 仓，不进 Latest 下载 |

> 命名红线：不叫 dsh-TUI / DeepSeek Harness Desktop（那是别人的产品名），不在 npm 冒用 `@deepseek-ai` 或 `dsh-tui` 的包名。我们基于官方内核，不是第二套 Harness。

[仓库](https://github.com/kamanager2012/dsh-community) · [Stable](https://github.com/kamanager2012/dsh-community/releases/latest) · [Releases](https://github.com/kamanager2012/dsh-community/releases) · [已验证插件](packages/marketplace/catalog.json)

开发基础是已发布的 `@deepseek-ai/dsh`。我们不 vendor 官方源码，也不用 `patch-package` 改官方 UI。扩展走外围发行层、契约层和插件验证层。

中文 | [使用指南](docs/getting-started.md) · [发行端与实验端定义](docs/community-endpoints.md) · [Architecture](ARCHITECTURE.md) · [重构说明](docs/reconstruction.md) · [Upgrade](docs/upgrade.md) · [TUI adapter](docs/tui-adapter.md) · [contracts](contracts/README.md) · [Version Manager](docs/version-manager.md)

## 现在能给谁用

| 你要什么 | 用谁 |
|---|---|
| 真正跑 agent | 官方 [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) |
| 终端 | 本仓 `dsh-community`（启动官方 `dsh --profile headless`，不挂第三方 TUI） |
| 下载安装包 | [Latest `v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest)（cosign 签名验证见 [release 文档](docs/release.md#artifact-signing-keyless)） |
| 已验证能装的社区插件 | Desktop 市场页 · 本仓 `pnpm marketplace` · [`packages/marketplace/catalog.json`](packages/marketplace/catalog.json)（不是 awesome 目录） |
| 官方表面快照 / 升 rc 契约 | **本仓** |

不要把本仓发到 npm 当 `@deepseek-ai/dsh` 或 `dsh-tui` 的替代。

## 社区生态导航

本仓是唯一用户下载入口。插件发现 CLI 和兼容性目录也在本仓；手册仍是独立仓。Labs、独立 Marketplace、独立 Plugins 已归档。

| 仓库 | 角色 | 现在实际是 |
|---|---|---|
| [`deepseek-harness-handbook`](https://github.com/kamanager2012/deepseek-harness-handbook) | 手册 | 知识 / 证据 |
| 本仓 `packages/marketplace` | 发现 / 安装 CLI + 兼容性目录 | `pnpm marketplace`；`catalog.json` 在本包内；安装仍走官方 `dsh plugin add` |
| [`deepseek-harness-suite`](https://github.com/kamanager2012/deepseek-harness-suite) | 已归档 Labs | 不要从那里安装 |
| [`dsh-marketplace`](https://github.com/kamanager2012/dsh-marketplace) | 已归档 | 跳转到本仓 marketplace 包 |
| [`dsh-community-plugins`](https://github.com/kamanager2012/dsh-community-plugins) | 已归档 | 跳转到本仓 marketplace 包 |
| [`dsh-community-edition`](https://github.com/kamanager2012/dsh-community-edition) | 已归档 | 不要从那里下载 |

官方执行核心仍是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。社区层不重新实现 Agent loop、不另建 session 目录、不用 patch 改官方 UI。

## 从源码跑

需要 Node 22.15+、pnpm，以及 `DEEPSEEK_API_KEY`。官方 0.1.0-rc.8 起，session JSONL 用了 `node:zlib` 的 zstd API（22.15 才有；当前 pin 以 contracts/compatibility/latest-tested.json 为准）。对话在官方 `~/.dsh`。没密钥不会闷头进 Ink。

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
export DEEPSEEK_API_KEY=...
pnpm start              # 有对话就接着最近一条，否则开新的
pnpm new                # 强制开新对话
pnpm desktop            # 桌面壳（含社区市场页）
pnpm marketplace -- list  # 插件发现 CLI（需先能访问注册表）
pnpm run doctor         # 自检（不要裸跑 pnpm doctor，那是 pnpm 自己的）
```

同一入口也叫 `dsh-community`（`dsh-community-tui` 仍可用）：

```sh
dsh-community                 # 有对话就接着最近一条
dsh-community new
dsh-community resume last
dsh-community sessions
dsh-community doctor
dsh-community version
dsh-community plugins         # 只读目录；安装仍走官方 dsh plugin add / 桌面市场页
dsh-community desktop
```

打 Linux 解包目录或 AppImage（预览，未签名）：

```sh
pnpm desktop:package
./apps/desktop/release/linux-unpacked/dsh-community

pnpm desktop:package -- --appimage
```

Windows / macOS 安装包由 GitHub Actions(`release` workflow)在对应系统构建,本地无需坐在那些 OS 上。不要 `npm publish` 本仓的 workspace 包。发布顺序见 [docs/release.md](docs/release.md)。

## 硬边界

| 做 | 不做 |
|---|---|
| 依赖已发布的 `@deepseek-ai/dsh` | 不 vendor 官方 `packages/*`（Official Source Ownership = 0） |
| Desktop 子进程启动 `dsh web`，只管理生命周期 | 不把 stdout 解析成业务协议 |
| 默认共用官方 `~/.dsh` session 真源 | 不把 DSH 数据迁进 Desktop AppData |
| 我们的 TUI 自己组合、自己列官方 session | 不把参考 TUI 当上游，不维护第二套 session log |
| `contracts/` 快照官方表面 | 不维护一套社区 `event-types.ts` |

## 成功标准

1. 官方源代码 vendor = 0
2. TUI 对官方 Cordis row 的覆盖数量显著下降（33 → 15 → 8 → 只剩 TUI 自己的 insert）
3. TUI/Desktop 不实现 Agent loop、Session persistence、Tool execution
4. 一次 upstream rc bump，业务 UI 原则上零修改
5. WSL/Linux TUI、Windows/macOS Desktop 与官方 Web 能共享同一 Session 真源
6. 新版本兼容问题首先在 contract CI 爆

当前：1 / 3 / 5 按设计成立；2 社区 overlay 只改官方行，不挂第三方 TUI。第 4 条是官方发新包时的回归。

## 仓库布局

```
contracts/              官方表面快照 + compatibility matrix
packages/dsh-bridge     解析官方 bin、生命周期、数据目录
packages/marketplace    插件发现 CLI + catalog.json
packages/tui-adapter    我们的 TUI 薄 patch + KPI
packages/shared-types   社区自己的类型，不是官方 event fork
apps/desktop            官方 `dsh web` 壳 + 官方 session 列表 + 内嵌社区市场页
apps/tui                官方 `dsh --profile` / `--resume` 启动器
tests/upstream-contract vendor=0、pin、CLI
```

## Security

见 [SECURITY.md](SECURITY.md)：Desktop 的 Electron 加固边界（contextIsolation / 权限默认拒绝 / 导航白名单）、cosign keyless 发行签名的验证方法、`~/.dsh` 会话数据共享范围，以及如何私下报告安全问题。

## License

MIT。运行时版权与第三方声明见 [NOTICE](NOTICE) 和官方包。
