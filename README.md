# dsh-community

**One Harness. Three Community Endpoints.**（一套 Harness，三个社区端）

官方 DeepSeek Harness 的社区发行版：同一套 Runtime、同一套 `~/.dsh` 会话、同一套官方插件。我们的三个社区端是 **WSL/Linux 终端、Windows 桌面、macOS 桌面**；官方 Web 是兼容对象，不是我们的发行端——但进的是同一个世界。不是官方客户端，也不是第二套 Harness。

你今天在官方 Web 开的对话，关掉以后用 `dsh-community` 终端可以接着聊；再打开 Desktop，还是同一条会话。

> **One Harness. Three Community Endpoints.** 官方 DeepSeek Harness Runtime 之上的社区发行版：同一套 Runtime、同一套 Session、同一套插件；三个社区端 = WSL/Linux 终端 + Windows 桌面 + macOS 桌面。不重写 Harness，不 patch 官方表面。

[English](README.en.md) | 简体中文

[![ci](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml)

| 通道 | 去哪下 |
|---|---|
| **Stable** | [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest) |
| **Preview** | [Releases](https://github.com/kamanager2012/dsh-community/releases) 里最新的 Pre-release |

当前社区产品号是 **0.1.6**：根目录、Desktop、TUI、workspace 包同一数字。官方 Runtime pin 仍是 `@deepseek-ai/dsh@0.1.0-rc.6`，那是上游版本，不是我们的号。下载只走 [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest)（`v0.1.6`）。不要下 `v0.1.3` / `v0.1.4` / `v0.1.5`。

| 发行面 | 命名 | 入口 |
|---|---|---|
| 官方 Web | 官方上游兼容入口，不是 Community 发行端 | [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) |
| WSL/Linux 终端 | **社区端 1：Terminal / TUI** | `dsh-community` / `dsh-community-tui` / `pnpm tui` |
| Windows 桌面 | **社区端 2：Desktop** | [v0.1.6](https://github.com/kamanager2012/dsh-community/releases/latest) Setup.exe，或 `pnpm desktop` |
| macOS 桌面 | **社区端 3：Desktop** | [v0.1.6](https://github.com/kamanager2012/dsh-community/releases/latest) dmg，或 `pnpm desktop` |
| Linux AppImage | 可选 / 次要构建产物 | 随 Release 附带；Linux 主路径仍是 Terminal |

> 命名红线：不叫 dsh-TUI / DeepSeek Harness Desktop（那是别人的产品名），不在 npm 冒用 `@deepseek-ai` 或 `dsh-tui` 的包名。我们是发行版，不是再造一个桌面壳。

[仓库](https://github.com/kamanager2012/dsh-community) · [Stable](https://github.com/kamanager2012/dsh-community/releases/latest) · [Releases](https://github.com/kamanager2012/dsh-community/releases) · [已验证插件](https://github.com/kamanager2012/dsh-community-plugins)

开发基础是已发布的 `@deepseek-ai/dsh`。我们不 vendor 官方源码，也不用 `patch-package` 改官方 UI。扩展走外围发行层、契约层和插件验证层。

中文 | [使用指南](docs/getting-started.md) · [三个社区端定义](docs/community-endpoints.md) · [Architecture](ARCHITECTURE.md) · [重构说明](docs/reconstruction.md) · [Upgrade](docs/upgrade.md) · [TUI adapter](docs/tui-adapter.md) · [contracts](contracts/README.md) · [Version Manager](docs/version-manager.md)

## 现在能给谁用

| 你要什么 | 用谁 |
|---|---|
| 真正跑 agent | 官方 [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) |
| 终端 TUI | 本仓 `pnpm tui`（官方 profile + 薄 patch，Ink 只当挂载的插件） |
| 下载安装包 | [v0.1.6](https://github.com/kamanager2012/dsh-community/releases/latest) |
| 已验证能装的社区插件 | Desktop 市场页 · [`dsh-marketplace`](https://github.com/kamanager2012/dsh-marketplace) · [验证注册表](https://github.com/kamanager2012/dsh-community-plugins)（不是 awesome 目录） |
| 官方表面快照 / 升 rc 契约 | **本仓** |

不要把本仓发到 npm 当 `@deepseek-ai/dsh` 或 `dsh-tui` 的替代。

## 社区生态导航

本仓是唯一用户下载入口。六仓是发行版需要的**角色边界**；插件生态仍不等于“全量市场”，也不和 awesome 列表比收录数量。当前注册表有 9 个第三方插件完成 rc.6 的安装/组合验证，并继续补充 digest、provenance 和 runtime smoke 证据。

| 仓库 | 角色 | 现在实际是 |
|---|---|---|
| [`deepseek-harness-suite`](https://github.com/kamanager2012/deepseek-harness-suite) | Labs | 实验源，不是下载渠道 |
| [`deepseek-harness-handbook`](https://github.com/kamanager2012/deepseek-harness-handbook) | 手册 | 知识 / 证据，还在追代码 |
| [`dsh-community-plugins`](https://github.com/kamanager2012/dsh-community-plugins) | 验证注册表 | 9 个第三方插件已在 rc.6 上完成安装/组合验证；供应链 CI 持续校验 |
| [`dsh-marketplace`](https://github.com/kamanager2012/dsh-marketplace) | 发现 / 安装 UX | 稳定维护，当前测试 11/11；安装仍走官方 `dsh plugin add` |
| [`dsh-community-edition`](https://github.com/kamanager2012/dsh-community-edition) | 已归档 | 不要从那里下载 |

官方执行核心仍是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。社区层不重新实现 Agent loop、不另建 session 目录、不用 patch 改官方 UI。

## 从源码跑

需要 Node 22+、pnpm，以及 `DEEPSEEK_API_KEY`。对话在官方 `~/.dsh`。没密钥不会闷头进 Ink。

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
export DEEPSEEK_API_KEY=...
pnpm start              # 有对话就接着最近一条，否则开新的
pnpm new                # 强制开新对话
pnpm desktop            # 桌面壳（含社区市场页）
pnpm doctor             # 自检
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

当前：1 / 3 / 5 按设计成立；2 我们的 TUI 自有面 8 行（参考物 33）。第 4 条是官方发新包时的回归，不挡我们继续做发行面。

## 仓库布局

```
contracts/              官方表面快照 + compatibility matrix
packages/dsh-bridge     解析官方 bin、生命周期、数据目录
packages/tui-adapter    我们的 TUI 薄 patch + KPI
packages/shared-types   社区自己的类型，不是官方 event fork
apps/desktop            官方 `dsh web` 壳 + 官方 session 列表 + 内嵌社区市场页
apps/tui                官方 `dsh --profile` / `--resume` 启动器
tests/upstream-contract vendor=0、pin、CLI
```

## License

MIT。运行时版权与第三方声明见 [NOTICE](NOTICE) 和官方包。
