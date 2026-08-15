# TUI adapter

官方当前发行面是 `cli` 和 `web`。社区 TUI（`@deepseek-harness-tui/dsh-tui`）是 Cordis 插件：profile + `cordis.patch.yml` + Ink。

这不等于“官方永远不做 TUI”。架构决定仍然成立：第三方 TUI 走公开 seam（`ctx.agents` + `session/event` + `Agent.followup`），不 fork core。

本仓**不重写** Ink。`packages/tui-adapter` 只钉 seam 和 **patch-surface KPI**。

## 官方契约

> Add UI or editor integration → drive `ctx.agents` and render from `session/event`.

## KPI：Patch Surface Reduction

上游 `cordis.patch.yml`（dsh-TUI 0.6.1 / 官方 rc.6）仍是 **33** 行。

对照官方 `dsh-web-app` 后：其中 **23 个 disable + 2 个官方 insert** 是 preset 隔离（和官方 Web 同一套路），不是 Ink/TUI 自己的面。

本仓第一刀已经拆开：

| 文件 | 行数 | 含义 |
|---|---|---|
| `patches/preset-isolation.cordis.patch.yml` | 25 | 与官方 web-app 相同的 host-plane 下沉 |
| `patches/tui-owned.cordis.patch.yml` | 5 已写 + 3 待从上游搬配置 | TUI 自己的面，已低于 15 |

```
上游 33
→ 社区 TUI-owned 8（第一档，已过 15）
→ 只剩 insert dsh-tui / working-activity
```

Ink 未动。上游 TUI 包仍会应用完整 33 行；社区文件是下一刀要让上游吃的目标 patch。

理想终态大致是：

```yaml
- insert:
    - id: dsh-tui
      name: '@deepseek-harness-tui/dsh-tui'
    - id: tui-working-activity
      name: '@…/dsh-working-activity'
```

| 能力 | 应归谁 |
|---|---|
| permission | 官方 preset |
| agent | 官方 preset |
| session | 官方 persistence（`~/.dsh`） |
| LLM | 官方 provider |
| compaction | 官方 |

见 `contracts/compatibility/tui-patch-surface.json`。

## 启动方式

```sh
dsh plugin --profile tui add @deepseek-harness-tui/dsh-tui
dsh --profile tui
```
