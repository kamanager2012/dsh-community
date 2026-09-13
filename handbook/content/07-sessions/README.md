# Session 与状态

Session 是 Agent 工作的持久边界。它不只是聊天记录，还可能包含工具事件、模型、cwd、持久 Shell、父子关系和恢复元数据。

## 本章路径

- [Session 模型](model.md)
- [history、resume 和 fork](../core/session-lifecycle.md)
- [持久化与日志](persistence.md)
- [恢复与清理](recovery.md)
- [Web 页面中的 session](../02-web-ui/workspaces-and-sessions.md)

## 选择原则

- 新目标：新 session；
- 同一目标、同一 workspace、上下文仍然正确：可继续；
- 想保留父任务但探索另一条路线：fork（当前入口支持时）；
- 只想查看过去：读取 history，不要启动 Agent；
- 不确定状态：先停，记录检查点，再新建 session。
