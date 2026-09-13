# Session：继续、恢复与分叉不是一回事

很多 Agent 系统把 session 当作“聊天记录 ID”，这会造成三个误判：重新打开历史被当成恢复执行，同一个 session ID 被当成 fork，一个入口的恢复能力被误写到另一个入口。

可以把 session 理解为四层：

```text
事件日志       = 发生过什么的追加记录
派生历史       = 提供给模型的消息视图
运行时 Agent   = 当前是否有可执行的活跃主体
session header = cwd、血统、组合和格式等恢复信息
```

事件、历史和运行时不是同一个对象。

## 四种常见动作

| 动作 | 是否产生新 session | 是否启动 Agent | 适合什么时候 |
| --- | --- | --- | --- |
| 读取 history | 否 | 否 | 查看过去发生了什么 |
| Resume / reopen | 否 | 是，若当前入口支持 | 继续原任务 |
| 同一 session 再次 run | 通常不新建 ID | 由 SDK/runtime 继续 | 需要保留上下文时 |
| Fork / Branch | 是 | 取决于入口 | 从某个已完成节点开新路线 |

具体入口是否支持某个动作，以当前版本的 Web UI、CLI 或 SDK 文档为准；不要把 Web 的按钮直接推断成 headless 或 SDK 的同名能力。

## history 不等于恢复

能看到上一轮消息，只说明历史可读：

```text
我能看到上一轮消息
≠
上一轮 Agent 已经恢复，可以继续执行
```

恢复任务前，确认：

- session ID 是否保持；
- cwd 是否仍指向原 workspace；
- Provider、模型和 Agent composition 是否符合预期；
- 新事件是否追加到原日志；
- 恢复失败时是否明确报错，而不是静默创建新 session。

## Fork 是新的事实链

Fork 应当创建新的 session，并保留父子关系。实际使用时检查：

```text
child.session_id ≠ parent.session_id
child.parentSessionId = parent.session_id
child 从 parent 的已完成前缀开始
parent 在 fork 后不被改写
child 可以独立追加后续事件
```

如果锚点落在仍未完成的 turn 中，不要假设系统会安全截断；先查当前版本的行为，再把操作改为从已完成节点分叉。

## 长任务的推荐做法

1. 在任务文本中定义阶段、检查点和交付条件；
2. 每个阶段结束保存当前 diff、测试结果和未完成项；
3. 恢复前重新确认 workspace、模型、权限和 session；
4. 发现上下文或工作区不一致时，新建 session 并重新说明背景；
5. 不要为了保留上下文而无限复用旧 session。

## 入口差异

- Web UI 适合人工查看历史、确认权限和交互式恢复；
- headless 适合一次性任务，重点是退出码和外部验收；
- Python SDK 适合程序控制，重点是 `session_id`、事件、异常和持久化目录；
- 低层 JSON-RPC 或内部 Host API 适合扩展开发，不应直接当作长期稳定的普通用户入口。

官方 CLI 行为说明见[中文 CLI 参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.zh.md)。
