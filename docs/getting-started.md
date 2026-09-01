# DSH Community 使用指南

> 面向第一次使用者的任务型入口。事实快照：2026-08-21。

[English](getting-started.en.md) · [返回中文 README](../README.md) · [发行端与实验端定义](community-endpoints.md) · [在线 Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/)

## 先选正确入口

| 目标 | 入口 | 说明 |
| --- | --- | --- |
| 直接使用官方 Runtime | [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) | 官方产品路径 |
| 使用社区终端 / TUI | 本仓库 `dsh-community` 或源码中的 `pnpm tui` | 社区 UX，执行核心仍是官方 Runtime |
| 下载 Windows 桌面包 | [Latest `v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest) | 新 tag 需重跑 exact-asset smoke；完整用户闭环仍需复核 |
| 下载 macOS 桌面包 | [Latest `v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest) | 新 tag 需重跑 exact-asset smoke；完整用户闭环仍需复核 |
| 使用 WSL/Linux 终端 | `dsh-community` / `pnpm tui` | Linux 的主力 Community endpoint |
| 查完整操作手册 | [DeepSeek Harness Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/) | Provider、Session、安全、自动化和验收 |

不要从已归档的 Suite、独立 Marketplace、独立 Plugins 或 Edition 下载正式客户端。**Published Latest** 仍以 [releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest) 和 `current-release.json` 中的 `githubLatestTag / publishedAssets / publishedReleaseEvidence` 为准；发行产物带 keyless cosign 签名（`.sigstore.json`）。不要下载历史编号 `v0.1.2`–`v0.1.6` 当当前产品。官方 Web 是上游兼容入口，不是 Community 发行端。当前四个已发行端与 Android `[UNVERIFIED]` 实验端的定义见 [community-endpoints.md](community-endpoints.md)。详见[版本策略](version-policy.md)。

从源码运行时，Desktop/TUI 显示的是 **Candidate Source** 的 Dual-Badge，而不是 Published Latest 的版本号。候选 core、产品号、`candidateTag` 与 Dual-Badge 统一读取 [`current-release.json`](current-release.json)；源码候选可以领先于已发布下载。

## 当前已发布下载资产

[`v0.1.1-rc.2`](https://github.com/kamanager2012/dsh-community/releases/latest)：

- `DSH Community Setup 0.1.1-rc.2.exe` — Windows（GitHub 可能把空格显示成点）
- `dsh-community-0.1.1-rc.2.dmg` — macOS
- `dsh-community-0.1.1-rc.2.AppImage` — Linux 第 4 端

以 Release 页上的精确文件名为准。每个文件都有对应的 `.sha256`。Windows / macOS 包**未签名、未公证**。Windows 可能弹出 SmartScreen「未知发布者」：选「更多信息 → 仍要运行」，然后用 sidecar 校验：

```sh
# Windows PowerShell:
Get-FileHash 'DSH Community Setup 0.1.1-rc.2.exe' -Algorithm SHA256
# macOS / Linux:
shasum -a 256 -c dsh-community-0.1.1-rc.2.dmg.sha256
```

第一次打开桌面会解一份官方 Runtime 到用户数据目录，只做一次。对话仍在官方 `~/.dsh`。

## 五分钟从源码启动

需要 Node.js 22.15+、pnpm 和可用的 `DEEPSEEK_API_KEY`（官方 0.1.0-rc.8 起 session JSONL 依赖 `node:zlib` zstd，22.15 才有）：

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
export DEEPSEEK_API_KEY=...
pnpm run doctor
pnpm start
```

Windows PowerShell 可以使用：

```powershell
$env:DEEPSEEK_API_KEY = "..."
pnpm run doctor
pnpm start
```

`doctor` 是启动前检查，不会替你验证模型调用已经成功。首次任务完成后仍应检查实际输出、`git diff` 和退出状态。

## 常用入口

```sh
dsh-community                 # 有可恢复会话时继续最近会话
dsh-community new             # 新建会话
dsh-community resume last     # 恢复最近会话
dsh-community sessions        # 查看官方会话列表
dsh-community doctor          # 检查运行环境
dsh-community version         # 查看社区层版本信息
dsh-community plugins         # 只读查看插件目录
dsh-community desktop         # 启动桌面壳
```

源码开发时也可以使用 `pnpm start`、`pnpm new`、`pnpm run doctor`、`pnpm desktop`。不要裸跑 `pnpm doctor`（那是 pnpm 自己的命令）。插件安装不要由社区层重新实现，继续使用官方 `dsh plugin add` 链路或 Desktop 市场页。

## 会话和数据边界

- 官方 Session 真源仍在 `~/.dsh`；Community 不维护第二套等价 Session persistence。
- `new`、`resume` 和 `sessions` 是入口体验，不代表社区层拥有官方 Session 数据格式。
- 需要备份、恢复、事件阅读或自动化时，先看 Handbook 的 [Session 章节](https://kamanager2012.github.io/deepseek-harness-handbook/content/07-sessions/)。
- 不要把 API key、私有 Session 或客户数据放进仓库、截图或 issue。

## 插件路径

```text
packages/marketplace/catalog.json
          ↓ 兼容性和验证信息
      packages/marketplace（CLI：dsh-marketplace / pnpm marketplace）
          ↓ 用户选择
官方 dsh plugin add / 官方安装链
```

注册表不是安全保证，也不替代官方安装器。没有匹配 `testedDsh` 线的条目应按 `[UNVERIFIED]` 处理。

- [插件目录 catalog.json](../packages/marketplace/catalog.json)
- [Marketplace 使用说明](../packages/marketplace/docs/usage.md)
- [插件验证指南](../packages/marketplace/docs/registry-guide.md)

## 常见问题

| 症状 | 先检查 | 不要做什么 |
| --- | --- | --- |
| `dsh-community: command not found` | 先用源码命令，或确认安装包 PATH | 不要把本仓库发布成 `@deepseek-ai/dsh` |
| 没有模型响应 | `DEEPSEEK_API_KEY`、Provider 配置和 `dsh web --help` | 不要把 `doctor` 通过当成模型调用通过 |
| 端口被占用 | `doctor` 输出和官方 `dsh web` 进程 | 不要用 `killall node` 误杀其他项目 |
| 不知道下载哪个版本 | [Published Latest](https://github.com/kamanager2012/dsh-community/releases/latest) | 精确 tag / 文件名看 `current-release.json`；不要下历史 `v0.1.2`–`v0.1.6` |
| 想试未发布的 SDK / Checkpoint 实验 | 那些实验已随 Labs 仓归档，不是产品通道 | 不要从归档仓安装 |

## 继续阅读

- [架构边界](../ARCHITECTURE.md)
- [发布指南](release.md)
- [升级说明](upgrade.md)
- [契约快照](../contracts/README.md)
- [生态说明](../ECOSYSTEM.md)
- [官方 Runtime](https://github.com/deepseek-ai/deepseek-harness)
