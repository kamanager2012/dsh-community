# dsh-community

**DSH 社区版（DeepSeek Harness Community Edition）—— 0.1.1.**

只发布在 [github.com/kamanager2012/dsh-community](https://github.com/kamanager2012/dsh-community)。官方 Runtime 的社区发行层，不是官方客户端，也不是第二套 harness。

[![ci](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml/badge.svg)](https://github.com/kamanager2012/dsh-community/actions/workflows/ci.yml)

| 发行面 | 命名 | 入口 |
|---|---|---|
| 终端 | **社区版·终端** | `dsh-community-tui` / `pnpm tui` |
| 桌面 | **社区版·桌面** | Linux AppImage / `pnpm desktop` |

> 命名红线：不叫 dsh-TUI / DeepSeek Harness Desktop（那是参考物），不在 npm 冒用 `@deepseek-ai` 或 `dsh-tui` 的包名。

[仓库](https://github.com/kamanager2012/dsh-community) · [Release](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.1) · [插件市场](https://github.com/kamanager2012/dsh-community-plugins)

开发基础是官方 DeepSeek Harness（`@deepseek-ai/dsh`）。我们在这上面做 Terminal / Desktop 发行和契约层，不另写一套 harness。

中文 | [Architecture](ARCHITECTURE.md) · [重构说明](docs/reconstruction.md) · [Upgrade](docs/upgrade.md) · [TUI adapter](docs/tui-adapter.md) · [contracts](contracts/README.md) · [Version Manager](docs/version-manager.md)

## 现在能给谁用

| 你要什么 | 用谁 |
|---|---|
| 真正跑 agent | 官方 [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) |
| 终端 TUI | 本仓 `pnpm tui`（官方 profile + 薄 patch，Ink 只当挂载的插件） |
| Linux 桌面 | [0.1.1 AppImage](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.1) 或 `pnpm desktop`（含内嵌社区市场页） |
| 浏览 / 安装社区插件 | Desktop 社区市场页 · [`dsh-marketplace`](https://github.com/kamanager2012/dsh-marketplace) CLI · [注册表](https://github.com/kamanager2012/dsh-community-plugins) |
| 官方表面快照 / 升 rc 契约 | **本仓** |

不要把本仓发到 npm 当 `@deepseek-ai/dsh` 或 `dsh-tui` 的替代。

## 从源码跑

需要 Node 22+ 和 pnpm。

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
pnpm test
pnpm desktop          # 官方 dsh web + 薄壳
pnpm tui              # 官方 dsh --profile dsh-community-tui
```

会拉起已发布的 `@deepseek-ai/dsh@0.1.0-rc.6`，默认共用官方 `~/.dsh`。

```sh
dsh-community-tui --help
dsh-community-tui --list-sessions
dsh-community-tui --resume <official-session-id>
```

打 Linux 解包目录或 AppImage（预览，未签名）：

```sh
pnpm desktop:package
./apps/desktop/release/linux-unpacked/dsh-community

pnpm desktop:package -- --appimage
```

Windows / macOS 在对应系统上：`pnpm desktop:package -- --win` 或 `--mac`。不要 `npm publish` 本仓的 workspace 包。发布顺序见 [docs/release.md](docs/release.md)。

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
5. TUI / Desktop / 官方 Web 能共享同一 Session 真源
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
