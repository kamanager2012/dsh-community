# DeepSeek Harness Community 生态与产品入口

> 本页是 DeepSeek Harness Community 生态的项目 handoff。基线日期：2026-08-21。

本项目不是 DeepSeek Harness 的 fork，也不是另一套 Agent Runtime。唯一的执行核心仍然是官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；社区仓库围绕官方 Runtime 提供发行、兼容、插件、知识、诊断和实验能力。

## 先记住三个结论

1. **官方 Runtime 是发动机**：Agent loop、模型调用、工具执行、官方 session 持久化和核心生命周期由官方 Runtime 负责。
2. **`dsh-community` 是唯一正式产品**：普通用户只需要下载、安装和使用它。
3. **Suite 已归档**：`deepseek-harness-suite` 是冻结的 Labs，不是下载渠道。独立 Marketplace 仓和独立 Plugins 仓同样已归档。新工作只发生在 `dsh-community` 和本手册。

## 普通用户从哪里开始

```text
官方 DeepSeek Harness Runtime
            │
            ▼
       dsh-community
        ├── WSL/Linux Terminal
        ├── Windows Desktop
        ├── macOS Desktop
        ├── Linux AppImage
        └── Android (archived Labs / UNVERIFIED)
```

正式软件入口统一指向 [`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest)。GitHub Latest 是 `v0.1.1-rc.2`，与官方内核 `@deepseek-ai/dsh@0.1.1-rc.2` 1:1 同号。代码线、Release 和门禁状态统一查看[当前发行状态](../11-operations/community-release-status.md)与[发布 Runbook](../11-operations/community-release-runbook.md)。历史独立编号 `v0.1.2`–`v0.1.6` 已降为 Pre-release，不是下载入口。

五个社区端是 **WSL/Linux Terminal、Windows Desktop、macOS Desktop、Linux AppImage、Android**。前四个随 Latest 发布；Android 原型留在已归档 Labs，保持 `[UNVERIFIED]`，不进 Latest。官方 Web 是内核自带界面，共享 `~/.dsh`，不是社区端。

用户不要从 `Suite` 下载客户端（已归档 Labs）；独立 `Marketplace`、`Plugins`、`Edition` 仓已在内容合流后删除（2026-09-13）。插件目录在产品仓 `packages/marketplace/catalog.json`。

## 公开仓库的职责

| 仓库 | 定位 | 面向谁 | 是否是正式下载入口 |
| --- | --- | --- | --- |
| [`dsh-community`](https://github.com/kamanager2012/dsh-community) | Canonical Product：官方 Runtime 上的 Desktop、TUI、诊断、兼容和发行层 | 所有用户、维护者 | **是，唯一入口** |
| 本仓 `handbook/`（原 `deepseek-harness-handbook`，已并入） | Knowledge / Evidence：工程实施、验收、运维和版本事实 | 用户、维护者、Agent | 否 |
| [`dsh-community` packages/marketplace](https://github.com/kamanager2012/dsh-community/tree/main/packages/marketplace) | Discovery / Distribution UX + 兼容性目录 `catalog.json` | 用户、插件作者 | 否；不是 Runtime |
| [`deepseek-harness-suite`](https://github.com/kamanager2012/deepseek-harness-suite) | 已归档 Labs；最后 Labs pin 是 `0.1.0-rc.6`，不是当前 Latest | 历史参考 | 否；不要安装 |

独立仓 `dsh-marketplace`、`dsh-community-plugins`、`dsh-community-edition` 的内容已并入产品仓，三仓于 2026-09-13 删除。

关系可以简化为：

```text
                         Official DeepSeek Harness
                                  │
                                  ▼
                    ┌────────────────────────────┐
                    │       dsh-community        │
                    │  Canonical Product         │
                    │  + packages/marketplace    │
                    └────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
             Handbook / Evidence        Plugins / Registry

             deepseek-harness-suite → Archived Labs（不要安装）
             独立 Marketplace / Plugins / Edition → 已删除（2026-09-13，内容并入产品仓）
```

## 官方层和社区层的边界

| 官方 Runtime 负责 | 社区层负责 |
| --- | --- |
| Agent loop 和模型执行 | Desktop / TUI 发行体验 |
| 工具执行和 Runtime 生命周期 | 生命周期包装、诊断和兼容层 |
| 官方 Session persistence | 官方 session 的读取、恢复和展示 |
| 官方事件与插件 surface | Bridge normalization、插件目录和验证说明 |
| 官方 profile、CLI 和协议 | 安全集成、发行打包和用户入口 |

社区层不得重新实现 Agent loop、维护第二套等价 Session 真源、fork 官方 event vocabulary，或 vendor 官方 core packages。官方能力已经存在时，优先调用官方能力；只有确认存在缺口时才增加社区扩展。

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

兼容性目录和 Marketplace CLI 都在 `dsh-community/packages/marketplace`（命令仍叫 `dsh-marketplace` / `pnpm marketplace`）。目录不是另一个 Plugin Manager，CLI 不是 Package Manager replacement，也不拥有 Runtime。安装应尽量回到官方 `dsh plugin add` 链路。独立仓 `dsh-community-plugins` 已删除（内容并入 `catalog.json`）。

当前证据快照 [待复核]：注册表有 9 个验证插件；CI 检查 shape、npm 存在性/版本、`dist.integrity`、provenance 和仓库可达性，compose workflow 逐个运行官方 `dsh plugin add` 并做合成断言。Marketplace CLI 提供 `list` / `search` / `info` / `install`；`info` 展示 digest/provenance，安装仍走官方链路。

当前发布边界 `[PARTIAL]`：GitHub Actions run [32489762676](https://github.com/kamanager2012/dsh-community/actions/runs/32489762676) 已从 `v0.1.1-rc.1` Release 页面下载真实资产，完成 checksum、Windows/macOS 安装与 Runtime 首启、Linux TUI 缺 key/无 TTY 检查，四个 job 全部通过。它仍不是完整用户闭环；Session 共享、插件重启、升级/卸载重装和网络失败路径仍需复核。历史独立编号 `v0.1.2`–`v0.1.6` 也不是用户下载版本。

## 面向维护者的阅读入口

- 想了解当前边界：阅读本页和 [官方架构概览](architecture.md)。
- 想判断 Stable、Preview、代码线和三平台门禁：阅读[当前发行状态](../11-operations/community-release-status.md)。
- 想看冻结 Labs 的历史门禁：阅读 [Community Labs handoff](../11-operations/community-labs-handoff.md)（仓库已归档，不再作为研发入口）。
- 想发布正式版本：阅读 [发布检查清单](../11-operations/release-checklist.md)。
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
