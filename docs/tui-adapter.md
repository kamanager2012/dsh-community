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
- 输入系统自研(无 ink-text-input 依赖):官方 CLI 先启用了 stdin raw 模式,
  释放后终端输入按 cooked 整行送达(如 `"y\r"`、`"/help\r"` 整个 chunk);
  按键层把 chunk 拆成字符规范化处理,raw/cooked 双模式兼容;draft 状态存 store,
  不走 React state(规避 useInput 闭包过期)。
- 官方工具全部启用:执行与审批走官方瀑布,社区层不实现第二套工具层。
- 审批升级链路(已端到端实测):workspace-write 下写工作区外非临时路径
  → 官方沙箱拒绝 → 模型带 `sandbox_permissions`/`justification` 升级
  → `ctx.approval.request` 瀑布 → 自研弹窗 → `y` 放行 → 官方执行。
  (`/tmp` 属官方 writableRoots,写 /tmp 不触发审批。)
- 模型驱动对齐官方 runner 模式:`agentDefaultModel.currentSelection()`
  + `installModelSelection` + 显式 `agentOptions`(缺失会导致 turn 静默不启动)。
- 事件折叠:`session/event` 载荷是 `{log: SessionEvent[]}` 批次,按 `seq` 去重;
  `user/message` 两种形状:注入路径 `data.message.content`,
  交互路径 `data.content` 直挂——两种都处理,`source.kind !== 'user'`
  (runtime-context 快照)过滤掉。

社区层只做入口与界面:`new` / `resume` / `sessions` / `doctor`。
不重写 Agent loop,不另建 session 目录。

## KPI

| 项 | 值 |
|---|---|
| 自有配置行 | 6 |
| 工具禁用 | 0 |
| 自研 insert | 1(dsh-community-tui) |
| 第三方挂载 | 0(CI 强制) |
