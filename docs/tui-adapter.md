# TUI adapter

官方当前发行面是 `cli` 和 `web`。社区 TUI（`@deepseek-harness-tui/dsh-tui`）是 Cordis 插件：profile + `cordis.patch.yml` + Ink。

这不等于“官方永远不做 TUI”。架构决定仍然成立：第三方 TUI 走公开 seam（`ctx.agents` + `session/event` + `Agent.followup`），不 fork core。

本仓**不重写** Ink。`packages/tui-adapter` 只钉 seam 和 **patch-surface KPI**。

## 官方契约

> Add UI or editor integration → drive `ctx.agents` and render from `session/event`.

## KPI：Patch Surface Reduction

当前 `cordis.patch.yml`（dsh-TUI 0.6.1 / 官方 rc.6）干预 **33** 个 rows：6 个 override、23 个 disable、4 个 insert。

目标不是“重写得更优雅”，而是把官方 row 交回去：

```
33 → 15 → 8 → 只剩 TUI 自己的 insert（dsh-tui, working-activity）
```

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
