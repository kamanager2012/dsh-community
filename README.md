# dsh-community

**一套 Harness，三个社区端。**

官方 DeepSeek Harness 的社区发行版。我们发行的是三个社区端，不是官方 Web：

```text
                    Official DeepSeek Harness Runtime
                                │
               ┌────────────────┼────────────────┐
               │                │                │
               ▼                ▼                ▼
        WSL / Linux TUI    Windows Desktop   macOS Desktop
         dsh-community        Setup.exe            dmg
```

同一套 Runtime、同一套 `~/.dsh`、同一套官方插件。官方 Web 是 DeepSeek 官方入口，和社区端共用 Session，**不是我们的第四个产品端**。Linux AppImage 仍会随 Release 附带，但是次要产物，不是主产品端。

不重写 Harness，不 patch 官方表面。

[English](README.en.md) | 简体中文 | [三个社区端定义](docs/community-endpoints.md)

[![ci](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml)

| 通道 | 去哪下 |
|---|---|
| **Stable** | [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest) |
| **Preview** | [Releases](https://github.com/kamanager2012/dsh-community/releases) 里最新的 Pre-release |

代码版本看根目录 `package.json`，不要把开发号、Preview tag 和 Stable Latest 混成一个数。当前 Latest 是 **[v0.1.4](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.4)**。`v0.1.2` 是第一个三系统基线；`v0.1.3` 是 Pre-release，不要下。不要再推广 v0.1.1 AppImage。干净环境上的用户闭环仍要单独验证，不能把 CI 绿当成 Reality Gate 已过。

## 三个社区端

| 社区端 | 面向谁 | 入口 |
|---|---|---|
| **WSL / Linux Terminal** | 开发者、CLI、Agent 重度用户、WSL2、Linux Server | `dsh-community` / `pnpm tui` |
| **Windows Desktop** | 不想先装 Node / CLI 的 Windows 用户 | [Latest](https://github.com/kamanager2012/dsh-community/releases/latest) 的 `DSH Community Setup.exe` |
| **macOS Desktop** | 不想先装 Node / CLI 的 macOS 用户 | [Latest](https://github.com/kamanager2012/dsh-community/releases/latest) 的 `dsh-community-*.dmg` |

| 不是我们的端 | 说明 |
|---|---|
| 官方 Web | 官方 [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness)，共用 `~/.dsh` |
| Linux AppImage | Release 仍附带，次要产物；Linux 主入口是终端，不是桌面壳 |

> 命名红线：不叫 dsh-TUI / DeepSeek Harness Desktop（那是别人的产品名），不在 npm 冒用 `@deepseek-ai` 或 `dsh-tui` 的包名。我们是发行版，不是再造一个桌面壳。不要说“我们有 Web + Desktop + Terminal 三端”。

[仓库](https://github.com/kamanager2012/dsh-community) · [Stable](https://github.com/kamanager2012/dsh-community/releases/latest) · [Releases](https://github.com/kamanager2012/dsh-community/releases) · [已验证插件](https://github.com/kamanager2012/dsh-community-plugins)

开发基础是已发布的 `@deepseek-ai/dsh`。我们不 vendor 官方源码，也不用 `patch-package` 改官方 UI。扩展走外围发行层、契约层和插件验证层。

中文 | [使用指南](docs/getting-started.md) · [Architecture](ARCHITECTURE.md) · [重构说明](docs/reconstruction.md) · [Upgrade](docs/upgrade.md) · [TUI adapter](docs/tui-adapter.md) · [contracts](contracts/README.md) · [Version Manager](docs/version-manager.md)

## 现在能给谁用

| 你要什么 | 用谁 |
|---|---|
| WSL / Linux 终端 | 本仓 `dsh-community` / `pnpm tui`（官方 profile + 薄 patch，Ink 只当挂载的插件） |
| Windows 桌面 | [Latest](https://github.com/kamanager2012/dsh-community/releases/latest) 的 Setup.exe |
| macOS 桌面 | [Latest](https://github.com/kamanager2012/dsh-community/releases/latest) 的 dmg |
| 官方 Web（不是我们的端） | [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) |
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

Linux 主产品端是上面的 `dsh-community` 终端，不是 AppImage。本地仍可打次要的 Linux 桌面包（未签名）：

```sh
pnpm desktop:package
./apps/desktop/release/linux-unpacked/dsh-community

pnpm desktop:package -- --appimage
```

Windows / macOS 安装包由 GitHub Actions(`release` workflow)在对应系统构建,本地无需坐在那些 OS 上。不要 `npm publish` 本仓的 workspace 包。发布顺序见 [docs/release.md](docs/release.md)。端定义见 [docs/community-endpoints.md](docs/community-endpoints.md)。

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
5. 三个社区端与官方 Web 能共享同一 Session 真源
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
