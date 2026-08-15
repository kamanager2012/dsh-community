# 这是重构，不是抄袭

不是做一个超级客户端，也不是简单做两个 UI。

是围绕官方 DSH Runtime，建立 **Terminal Distribution**、**Desktop Distribution** 和 **Compatibility Infrastructure** 三块社区资产。

**官方 DSH 是开发基础**：session、agent loop、工具、模型适配都在已发布的 `@deepseek-ai/dsh` 里，我们站在这上面做发行面。第三方 Desktop / TUI 只是**参考物**。我们的 Desktop 和 TUI 也是第三方产品，目标是**超过参考物**，不是给参考仓提补丁，也不是等官方再发一个 UI。

## 官方 TUI 现状（不要写死）

能确认的是：官方当前 `apps/` 只有 `cli` 和 `web`；架构文档要求 UI 走 `ctx.agents` + `session/event`。

这是很强的架构信号，**不是**“官方删除 TUI = 永远不做 TUI”。即使官方以后自己做 TUI，社区 TUI 仍应走公开 seam，而不是 fork core。

## Desktop IPC 必须薄

stdout/stderr 只当日志。业务状态走官方 HTTP / session/event。

Runtime Manager 只管理桌面壳必须知道、官方又没有当产品 API 暴露的生命周期：PID、启动成功、端口、退出码、crash、health。

不要从 stdout 解析 “Agent 正在 reasoning”，也不要逐年长出 Desktop Runtime Protocol。

## 数据目录

DSH 的数据继续归 DSH（默认 `~/.dsh`）。Desktop 自己的数据归 Desktop（window-state、runtime-versions、logs）。

默认共享官方 session store，这样 TUI 里建的 session，Desktop 还在。只有用户显式选择 Isolated Desktop Runtime 才改 `DSH_HOME`。

## TUI 的 KPI

参考 TUI 的 33 行 patch 是对照基线。我们自己的 TUI 产品要把**我们的**覆盖面压到：

`33（参考）→ 15 → 8 → 只剩我们挂上的 TUI 插件`。

权限、agent preset、session persistence、LLM、compaction 都该回到官方。

## Desktop 的 KPI

**Official Source Ownership = 0**。`@deepseek-ai/dsh` 是 dependency / runtime artifact，不是本仓的源码树。

## 成功标准

1. 官方源代码 vendor = 0
2. TUI 对官方 Cordis row 的覆盖数量显著下降
3. TUI/Desktop 不实现 Agent loop、Session persistence、Tool execution
4. 一次 upstream rc bump，业务 UI 原则上零修改
5. TUI / Desktop / 官方 Web 能共享同一 Session 真源
6. 新版本兼容问题首先在 contract CI 爆
