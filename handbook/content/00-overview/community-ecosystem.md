# DeepSeek Harness Community 生态与产品入口

> 本页是 DeepSeek Harness Community 生态的项目 handoff。基线日期：2026-11-19（Published Latest: `v0.2.2-rc.5`；Candidate Source: `v0.2.2-rc.5`；历史 Pre-release: `v0.2.2-rc.3-community.1`）。

本项目不是 DeepSeek Harness 的 fork，也不是另一套 Agent Runtime。唯一的执行核心仍然是官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；社区仓库围绕官方 Runtime 提供互补发行、多 Agent E2EE 远程控制面、兼容契约、插件目录、知识手册与安全验证能力。

## 先记住三个结论

1. **官方 Runtime 是发动机**：Agent loop、模型调用、工具执行、官方 session 持久化以及 Official Web / Windows / macOS Desktop 由官方上游负责。
2. **`dsh-community` 是唯一正式产品**：普通用户只需要下载、安装和使用它。
3. **Suite / Marketplace / Plugins / Edition 已合流归档**：`deepseek-harness-suite` 代码与历史已并入本仓 `archive/deepseek-harness-suite/`，不是下载渠道；独立 Marketplace、Plugins 与 Edition 仓已在内容并入后删除（2026-09-13）。

## 普通用户从哪里开始

```text
官方 DeepSeek Harness Runtime
  （Official Web + Win/macOS Desktop 归上游维护）
            │
            ▼
       dsh-community（三个互补社区端）
        ├── WSL/Linux Terminal（dsh-community / TUI）
        ├── Linux AppImage（Published Latest 主产物）
        └── Android Remote Client（apps/android，[UNVERIFIED]）
```

正式软件入口统一指向 [`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest)。当前 Published Latest 为 **`v0.2.2-rc.5`**（Release Commit `0a8009d0462042764ad67e87208df791f1f6180b`，同步官方内核 `@deepseek-ai/dsh@0.2.2-rc.5`，并通过 `artifact-smoke` [Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621)）；此前历史预发布 [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1) 已被 `v0.2.2-rc.5` 替代（详细状态与分离真源见 [`docs/current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json) 与[当前发行状态](../11-operations/community-release-status.md)）。

按照 **Complementary Edition** 边界：

- **三个互补社区端**：**WSL/Linux Terminal**（已发行）、**Linux AppImage**（已发行）与 **Android Remote Client**（`dsh-community-0.2.2-rc.5-android-arm64-v8a.apk` 已在 Published Latest 发行；CI `x86_64` 模拟器 E2EE 验收通过，物理真机遥测保持 `[UNVERIFIED]`）。
- Windows 与 macOS Desktop 安装包已自历史版本 `v0.1.1-rc.2` 后退役，交还官方上游 `deepseek-ai/deepseek-harness`（`--win` / `--mac` fail-closed）；历史独立编号 `v0.1.2`–`v0.1.6` 仅作历史记录，不是下载入口。
- 除 `~/.dsh` 会话互通外，本仓 `packages/remote-adapter` 与 `apps/remote-web` 还提供 **Multi-Agent E2EE 远程控制面**（Noise IK 加密、局域网/WebRTC/自部署盲中继），可统一控制本机 DSH、Claude Code、Codex CLI 与 OpenCode 并进行只读 Git diff 审查。

## 公开仓库的职责

| 仓库 | 定位 | 面向谁 | 是否是正式下载入口 |
| --- | --- | --- | --- |
| [`dsh-community`](https://github.com/kamanager2012/dsh-community) | Canonical Product：官方 Runtime 上的 Linux AppImage、TUI、E2EE 远程控制面、诊断、兼容与发行层 | 所有用户、维护者 | **是，唯一入口** |
| 本仓 `handbook/`（原 `deepseek-harness-handbook`，已并入） | Knowledge / Evidence：工程实施、验收、运维和版本事实 | 用户、维护者、Agent | 否 |
| [`dsh-community` packages/marketplace](https://github.com/kamanager2012/dsh-community/tree/main/packages/marketplace) | Discovery / Distribution UX + 兼容性目录 `catalog.json` | 用户、插件作者 | 否；不是 Runtime |
| 本仓 `archive/deepseek-harness-suite/`（原 `deepseek-harness-suite`，已并入） | 已归档 Labs；最后 Labs pin 是 `0.1.0-rc.6`，不是当前 Latest | 历史参考 | 否；不要安装 |

独立仓 `dsh-marketplace`、`dsh-community-plugins`、`dsh-community-edition` 的内容已并入产品仓，三仓于 2026-09-13 删除；`deepseek-harness-suite` 已连完整历史并入本仓 `archive/deepseek-harness-suite/`，原仓同期删除。

## 官方层和社区层的边界

| 官方 Runtime 负责 | 社区层负责 |
| --- | --- |
| Agent loop 和模型执行 | Linux AppImage / TUI 发行体验 |
| 工具执行和 Runtime 生命周期 | 生命周期包装、诊断和兼容层 |
| 官方 Session persistence | 官方 session 的读取、恢复与 E2EE 远程投射 |
| 官方事件与插件 surface | Bridge normalization、插件目录和验证说明 |
| 官方 Web 与 Win/macOS Desktop | 安全集成、无密钥签名打包和互补端入口 |

社区层不得重新实现 Agent loop、维护第二套等价 Session 真源、fork 官方 event vocabulary，或 vendor 官方 core packages（Official Source Ownership = 0）。官方能力已经存在时，优先调用官方能力；只有确认存在缺口时才增加社区扩展。

## 目录和安装不是两套产品

```text
dsh-community/packages/marketplace/catalog.json
        │  catalog / testedDsh / verification
        ▼
dsh-community/packages/marketplace
        │  browse / search / install UX
        ▼
官方 dsh plugin add / 官方安装链
```

兼容性目录和 Marketplace CLI 都在 `dsh-community/packages/marketplace`（命令为 `dsh-marketplace` / `pnpm marketplace`）。目录不是另一个 Plugin Manager，CLI 不是 Package Manager replacement，也不拥有 Runtime。安装应回到官方 `dsh plugin add` 链路。

当前证据快照：注册表有 9 个验证插件；CI 检查 shape、npm 存在性/版本、`dist.integrity`、provenance 和仓库可达性，`catalog.json` 中 5/9 个插件已完成 `@deepseek-ai/dsh@0.2.2-rc.5` 合成验证，`@deepseek-harness-tui/dsh-tui@0.20.1` 停留在 `0.2.2-rc.3`（其余 3 个旧插件保持 `0.1.1-rc.2`）。Marketplace CLI 提供 `list` / `search` / `info` / `install`。

当前发布边界：GitHub Actions `artifact-smoke` [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193)（`v0.2.2-rc.3` Latest）与 [Run 44005955539](https://github.com/kamanager2012/dsh-community/actions/runs/44005955539)（`v0.2.2-rc.3-community.1` Pre-release）已从各自 Release 页面下载真实资产，完成 `resolve`、`linux-appimage`、`android-apk`、`linux-terminal` 与 `verify-signatures`（cosign keyless 12 文件校验）；WSL/Linux 真实模型首对话与恢复闭环已通过 [Run 43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931) / [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) 验收 `[REAL]`，物理 `arm64-v8a` Android 真机遥测仍标为 `[UNVERIFIED]`。

## 面向维护者的阅读入口

- 想了解当前边界：阅读本页和 [官方架构概览](architecture.md)。
- 想判断 Candidate Source、Published Latest 与发行门禁：阅读[当前发行状态](../11-operations/community-release-status.md)。
- 想看冻结 Labs 的历史门禁：阅读 [Community Labs handoff](../11-operations/community-labs-handoff.md)（仓库已归档，不再作为研发入口）。
- 想发布正式版本：阅读 [发布检查清单](../11-operations/release-checklist.md) 与[发布 Runbook](../11-operations/community-release-runbook.md)。
- 想维护插件生态：阅读 [插件与 Cordis](../10-plugins/README.md)。

## 文档中的状态标签

文档必须区分“代码存在”和“能力已被真实证明”：

| 标签 | 含义 |
| --- | --- |
| `[REAL]` | 有对应代码、测试和可复现运行证据 |
| `[PARTIAL]` | 已实现一部分，但仍有已知缺口 |
| `[LABS]` | 只属于已归档 Community Labs，尚未进入正式产品 |
| `[PROBE]` | 探针可以观察到行为，但不等于稳定契约 |
| `[FAIL-CLOSED]` | 未知或高风险能力默认拒绝或要求审批 |
| `[WORKSPACE-JAIL]` | 已纳入 workspace 边界和越界测试 |
| `[BLOCKED_BY_UPSTREAM]` | 上游 Runtime 或 SDK 尚未提供完整闭环 |
| `[UNVERIFIED]` | 尚未完成真实 E2E、跨平台或失败路径验证 |
| `[NOT_IMPLEMENTED]` | 当前没有实现，不应以未来计划描述成现状 |

除非有相应证据，不要使用“production-ready”“完全安全”“100% 兼容”等表述。
