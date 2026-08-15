# dsh-community

**0.1.0-preview.** 社区发行层预览，不是官方客户端，也不是 TUI 替代品。

[仓库](https://github.com/kamanager2012/dsh-community) · [Release](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.0-preview)

围绕官方 DeepSeek Harness Runtime：Terminal Distribution 契约、Desktop 薄壳、Compatibility Infrastructure。不是超级客户端，也不是第二套 harness。

中文 | [Architecture](ARCHITECTURE.md) · [重构说明](docs/reconstruction.md) · [Upgrade](docs/upgrade.md) · [TUI adapter](docs/tui-adapter.md) · [contracts](contracts/README.md) · [Version Manager](docs/version-manager.md)

## 现在能给谁用

| 你要什么 | 用谁 |
|---|---|
| 真正跑 agent | 官方 [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) |
| 终端 TUI | 我们的 `pnpm tui`（参考 Ink，自己的薄 profile） |
| 下载即用的桌面安装包 | 第三方 Desktop 目前更完整；本仓 Desktop 是从源码跑的薄壳预览 |
| 官方表面快照 / 升 rc 契约 | **本仓** |

不要把本仓发到 npm 当 `@deepseek-ai/dsh` 或 `dsh-tui` 的替代。

## 从源码跑 Desktop 预览

需要 Node 22+ 和 pnpm。

```sh
git clone <this-repo> dsh-community
cd dsh-community
pnpm install
pnpm test
pnpm desktop
```

会拉起已发布的 `@deepseek-ai/dsh@0.1.0-rc.6`（`dsh web`），默认共用官方 `~/.dsh`。

打 Linux 解包目录（预览，未签名）：

```sh
pnpm desktop:package
./apps/desktop/release/linux-unpacked/dsh-community
```

Windows / macOS 在对应系统上：`pnpm desktop:package -- --win` 或 `--mac`。不要 `npm publish` 本仓的 workspace 包。发布顺序见 [docs/release.md](docs/release.md)。

## 硬边界

| 做 | 不做 |
|---|---|
| 依赖已发布的 `@deepseek-ai/dsh` | 不 vendor 官方 `packages/*`（Official Source Ownership = 0） |
| Desktop 子进程启动 `dsh web`，只管理生命周期 | 不把 stdout 解析成业务协议 |
| 默认共用官方 `~/.dsh` session 真源 | 不把 DSH 数据迁进 Desktop AppData |
| TUI 保留上游 Ink，KPI 是减少官方 row 覆盖 | 不重写 TUI，不断言“官方永远不做 TUI” |
| `contracts/` 快照官方表面 | 不维护一套社区 `event-types.ts` |

## 成功标准

1. 官方源代码 vendor = 0
2. TUI 对官方 Cordis row 的覆盖数量显著下降（33 → 15 → 8 → 只剩 TUI 自己的 insert）
3. TUI/Desktop 不实现 Agent loop、Session persistence、Tool execution
4. 一次 upstream rc bump，业务 UI 原则上零修改
5. TUI / Desktop / 官方 Web 能共享同一 Session 真源
6. 新版本兼容问题首先在 contract CI 爆

当前：1 / 3 / 5 按设计成立；2 我们的 TUI 产品已拆到 8 行自有面（参考物仍是 33）；4 还没做过一次真实 rc bump。

## 仓库布局

```
contracts/              官方表面快照 + compatibility matrix
packages/dsh-bridge     解析 bin、生命周期、数据目录边界
packages/tui-adapter    我们的 TUI 薄 patch + KPI
packages/shared-types   社区自己的类型，不是官方 event fork
apps/desktop            我们的 Desktop
apps/tui                我们的 TUI 启动器（dsh-community-tui）
tests/upstream-contract vendor=0、pin、CLI
```

## License

MIT。运行时版权与第三方声明见 [NOTICE](NOTICE) 和官方包。
