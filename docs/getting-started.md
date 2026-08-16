# DSH Community 使用指南

> 面向第一次使用者的任务型入口。事实快照：2026-08-16。

[English](getting-started.en.md) · [返回中文 README](../README.md) · [在线 Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/)

## 先选正确入口

| 目标 | 入口 | 说明 |
| --- | --- | --- |
| 直接使用官方 Runtime | [`npx @deepseek-ai/dsh web`](https://github.com/deepseek-ai/deepseek-harness) | 官方产品路径 |
| 使用社区终端 / TUI | 本仓库 `dsh-community` 或源码中的 `pnpm tui` | 社区 UX，执行核心仍是官方 Runtime |
| 下载 Windows 桌面包 | [v0.1.2 Latest](https://github.com/kamanager2012/dsh-community/releases/latest) | 不要下 v0.1.4 |
| 下载 macOS 桌面包 | [v0.1.2 Latest](https://github.com/kamanager2012/dsh-community/releases/latest) | 不要下 v0.1.4 |
| 使用 WSL/Linux 终端 | `dsh-community` / `pnpm tui` | Linux 的主力 Community endpoint |
| 查完整操作手册 | [DeepSeek Harness Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/) | Provider、Session、安全、自动化和验收 |

不要从 Suite、Marketplace、Plugins 或 Edition 下载正式客户端。它们分别是实验舱、发现体验、兼容注册表和历史归档。当前 Latest 是 `v0.1.2`。`v0.1.4` 桌面端解压后缺官方依赖，已标 Pre-release，不要下。官方 Web 是上游兼容入口，不是 Community 发行端；Linux AppImage 是可选/次要产物。

## 当前 Stable 下载资产

[`v0.1.4`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.4) 已发布：

- `dsh-community-0.1.4.AppImage`（可选/次要 Linux 产物）
- `dsh-community-0.1.4.dmg`
- `DSH.Community.Setup.0.1.4.exe`

每个安装包都有对应的 `.sha256` 文件。`v0.1.3` 是最新 Preview；`v0.1.2` 是历史 Stable 基线。

当前 exact-artifact smoke 的 macOS job 已通过、Windows job 失败，因此用户现实门禁仍是 `[UNVERIFIED]`；不要把发布链通过写成干净环境安装闭环已通过。

Windows / macOS 包**未签名、未公证**。Windows 可能弹出 SmartScreen「未知发布者」：选「更多信息 → 仍要运行」，然后用 sidecar 校验：

```sh
sha256sum -c dsh-community-0.1.4.AppImage.sha256
# Windows PowerShell:
Get-FileHash 'DSH.Community.Setup.0.1.4.exe' -Algorithm SHA256
```

第一次打开桌面会解一份官方 Runtime 到用户数据目录，只做一次。对话仍在官方 `~/.dsh`。

## 五分钟从源码启动

需要 Node.js 22+、pnpm 和可用的 `DEEPSEEK_API_KEY`：

```sh
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community
pnpm install
export DEEPSEEK_API_KEY=...
pnpm doctor
pnpm start
```

Windows PowerShell 可以使用：

```powershell
$env:DEEPSEEK_API_KEY = "..."
pnpm doctor
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

源码开发时也可以使用 `pnpm start`、`pnpm new`、`pnpm desktop`。插件安装不要由社区层重新实现，继续使用官方 `dsh plugin add` 链路或 Desktop 市场页。

## 会话和数据边界

- 官方 Session 真源仍在 `~/.dsh`；Community 不维护第二套等价 Session persistence。
- `new`、`resume` 和 `sessions` 是入口体验，不代表社区层拥有官方 Session 数据格式。
- 需要备份、恢复、事件阅读或自动化时，先看 Handbook 的 [Session 章节](https://kamanager2012.github.io/deepseek-harness-handbook/content/07-sessions/)。
- 不要把 API key、私有 Session 或客户数据放进仓库、截图或 issue。

## 插件路径

```text
dsh-community-plugins/catalog.json
          ↓ 兼容性和验证信息
      dsh-marketplace
          ↓ 用户选择
官方 dsh plugin add / 官方安装链
```

注册表不是安全保证，也不替代官方安装器。没有匹配 `testedDsh` 线的条目应按 `[UNVERIFIED]` 处理。

- [插件兼容性注册表](https://github.com/kamanager2012/dsh-community-plugins)
- [Marketplace 使用说明](https://github.com/kamanager2012/dsh-marketplace)
- [插件验证指南](https://github.com/kamanager2012/dsh-community-plugins/blob/main/docs/registry-guide.md)

## 常见问题

| 症状 | 先检查 | 不要做什么 |
| --- | --- | --- |
| `dsh-community: command not found` | 先用源码命令，或确认安装包 PATH | 不要把本仓库发布成 `@deepseek-ai/dsh` |
| 没有模型响应 | `DEEPSEEK_API_KEY`、Provider 配置和 `dsh web --help` | 不要把 `doctor` 通过当成模型调用通过 |
| 端口被占用 | `doctor` 输出和官方 `dsh web` 进程 | 不要用 `killall node` 误杀其他项目 |
| 不知道下载哪个版本 | 下载 [v0.1.2 Latest](https://github.com/kamanager2012/dsh-community/releases/latest) | 不要下 v0.1.4 桌面包，不要把 `package.json` 开发号当 Latest |
| 想试最新 SDK / Checkpoint | 进入 [Community Labs](https://github.com/kamanager2012/deepseek-harness-suite) | 不要把 Labs 当正式发行渠道 |

## 继续阅读

- [架构边界](../ARCHITECTURE.md)
- [发布指南](release.md)
- [升级说明](upgrade.md)
- [契约快照](../contracts/README.md)
- [六仓生态说明](../ECOSYSTEM.md)
- [官方 Runtime](https://github.com/deepseek-ai/deepseek-harness)
