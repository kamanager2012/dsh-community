# Session 模型

## 四个不同对象

~~~text
事件日志       发生过什么
派生历史       模型看到什么
运行时 Agent   当前谁在执行
Session header  如何找到 cwd、父会话和组合
~~~

如果只看到历史文本，不能断言 Agent 已经恢复。历史可读、运行时可执行和工作区仍然正确是三个独立问题。

## history

读取 history 的目标是检查已经持久化的事件，不应触发新的模型请求或工具动作。适合：

- 回顾已完成任务；
- 查找上次使用的模型；
- 找最后一个完整 turn；
- 比较父子 session；
- 为新任务整理背景。

不要因为 history 中出现一条“准备执行”消息，就断言命令已经执行。需要工具结果、退出码或外部状态。

## Resume

Resume/重新打开的目标是继续原 session。检查：

- session ID 没有改变；
- cwd 和 workspace 仍然有效；
- Provider、模型和 profile 仍然匹配；
- 新事件追加到原日志；
- 未完成工具和后台任务的状态可解释；
- 恢复失败不会静默创建新 session。

## Fork

Fork 应创建新的 child session，并保留 parent lineage。实际使用时检查：

~~~text
child.session_id 不等于 parent.session_id
child.parentSessionId 指向 parent
child 从 parent 的已完成边界开始
parent 的历史不被改写
child 可以独立追加
~~~

如果分叉点位于未完成 turn，不要假设系统会安全截断。先确认当前版本的边界，再从已完成节点分叉。

## SDK 的 session_id

Python SDK 中同一个 session_id 通常表示延续同一段持久化对话和 Shell 状态。独立任务使用新 ID。session_id 应该是可关联的业务句柄，而不是包含用户秘密的字符串。

## 入口差异

- Web UI 适合人工查看和确认；
- headless 重点是一次任务、输出和退出码；
- SDK 重点是 session_id、事件、结果和异常；
- 低层 Host API 或 JSON-RPC 适合扩展开发，不默认承诺长期稳定。
