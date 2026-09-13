# Community Labs Reality Gate

> 这是实验能力的证据入口，不是 Release 说明。事实快照：2026-08-16。

[English](reality-gate.en.md) · [返回中文 README](../README.zh-CN.md) · [Canonical Product](https://github.com/kamanager2012/dsh-community) · [Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/)

## 这页解决什么问题

Suite 可以包含高变化、高风险或依赖上游契约的实验代码。Reality Gate 的作用是把“代码存在”“适配器测试通过”“真实 Runtime 能力已证明”分开记录。

README、单元测试或 fallback 成功都不能单独把能力标成 `[REAL]`。

## 当前证据矩阵

| 能力 / 门禁 | 状态 | 当前含义 |
| --- | --- | --- |
| 构建、单元和契约测试 | `GREEN` | 仓库自己的构建与测试路径可运行 |
| Shell fail-closed | `[FAIL-CLOSED]` | compound operator、重定向、替换等高风险组合进入审批/拒绝路径 |
| `SessionEvent.data` adapter | `[REAL]` / adapter | 有结构化 envelope fixture 和 decoder 测试；不等于真实 Runtime E2E |
| Pre-enqueue fallback guard | `[REAL]` / failure path | prompt 已入队或已 active 后禁止自动重放 |
| True SDK runtime E2E | `[UNVERIFIED]` | 尚需真实 stdio JSON-RPC、prompt、事件流、最终响应和 `executionMode === sdk_jsonrpc` 硬断言 |
| Upstream contract probe CI | `RED` | 本地探针通过不等于上游 CI 稳定 |
| Interactive approval | `[BLOCKED_BY_UPSTREAM]` | 客户端可以判定风险，但官方 SDK 尚未提供完整 server→client approval 闭环 |
| Checkpoint | `[WORKSPACE-JAIL]` / `[PARTIAL]` | 工作区边界和越界防护已有；记录仍主要是进程生命周期内存状态，不应宣称 durable undo |
| Official Session | `[READ-SAFE]` | `~/.dsh/sessions` 只读；Suite 数据使用独立目录 |
| Android 端点（Termux runtime） | `[UNVERIFIED]` | `scripts/termux-verify.sh` 未在真机通过前，不宣称安卓端任何能力；Node 引擎（^22.19）与 `sharp` 原生依赖为已知风险，见 [android-endpoint.md](android-endpoint.md) |

## 运行本地证据

```bash
pnpm install
pnpm run build
pnpm run test
npx tsx scripts/contract-checker.ts
```

记录结果时至少写清楚：

- 使用的 `@deepseek-ai/dsh` 版本和 profile；
- 是 fixture / adapter 测试，还是实际启动官方 Runtime；
- 是否允许 fallback；
- 是否观察到真实 `SessionEvent`、tool event 和 turn end；
- 失败时的退出码、日志和清理结果。

## 进入 dsh-community 前的门禁

一个 Labs 能力需要依次通过：

```text
Reality Gate
  → upstream contract
  → security boundary
  → true E2E
  → cross-platform smoke
  → failure-path test
  → documentation
  → Canary → Preview → Stable
```

在证据不足时保持 `[LABS]`、`[PARTIAL]` 或 `[UNVERIFIED]`。不要用“production-ready”“完全兼容”“完全安全”替代证据。

## 架构边界

官方 Runtime 负责 Agent loop、模型/工具执行、官方 Session persistence 和核心生命周期。Suite 负责 Bridge、normalization、实验 UX、诊断和安全验证；不得 vendor 官方 core packages，也不得维护第二套 Runtime 或 Session 真源。

相关入口：

- [生态 handoff](ECOSYSTEM_HANDOFF.md)
- [Community README](https://github.com/kamanager2012/dsh-community/blob/main/README.md)
- [当前发行状态](https://kamanager2012.github.io/deepseek-harness-handbook/content/11-operations/community-release-status/)
- [插件兼容性注册表](https://github.com/kamanager2012/dsh-community-plugins)
- [官方 Runtime](https://github.com/deepseek-ai/deepseek-harness)
