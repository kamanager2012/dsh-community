# 社区终端

官方 DSH 是上游和运行时。

第三方 `dsh-TUI` / `@deepseek-harness-tui/dsh-tui` **只许参考,不许挂进产品**。

终端实际启动:

```sh
dsh --profile dsh-community-tui --patch <community overlay>
```

组成:

```text
bundles: [@deepseek-ai/dsh-base, @dsh-community/tui-surface]
overlay: 6 行自有配置(system-prompt / agent-loop / sandbox-policy /
         approval / session-persistence-jsonl),无任何工具禁用
```

- 自研终端面(`@dsh-community/tui-surface`):官方 seam 上的 Ink UI ——
  输入框 / transcript / 思考折叠 / 工具卡片 / 审批与提问弹窗 / 状态栏。
- 官方工具全部启用:执行与审批走官方瀑布,社区层不实现第二套工具层。
- 模型驱动对齐官方 runner 模式:`agentDefaultModel.currentSelection()`
  + `installModelSelection` + 显式 `agentOptions`(缺失会导致 turn 静默不启动)。
- 事件折叠:`session/event` 载荷是 `{log: SessionEvent[]}` 批次,按 `seq` 去重。

社区层只做入口与界面:`new` / `resume` / `sessions` / `doctor`。
不重写 Agent loop,不另建 session 目录。

## KPI

| 项 | 值 |
|---|---|
| 自有配置行 | 6 |
| 工具禁用 | 0 |
| 自研 insert | 1(dsh-community-tui) |
| 第三方挂载 | 0(CI 强制) |
