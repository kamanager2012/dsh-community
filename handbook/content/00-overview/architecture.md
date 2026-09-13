# dsh 架构：从插件树理解运行时

官方架构文档把 dsh 描述为由 Cordis 驱动的插件系统。改动包、开发插件或排查 profile 之前，先理解这棵树。

本页只描述**官方 Runtime**。如果你要了解社区发行层、插件注册表、Marketplace 和 Labs 的边界，请先读[Community 生态与产品入口](community-ecosystem.md)。社区层应通过公开 seam 接入官方 Runtime，而不是复制 Agent loop、Session 真源或官方 core packages。

## 插件树

~~~text
空上下文
  → dsh-base
      → 模型适配器
      → 工具注册表
      → session
      → sandbox / approval
      → settings / credentials / telemetry
  → dsh-web-app 或 dsh-headless
  → profile patch
  → DSH_HOME patch
  → 本次 overlay
~~~

运行时不是静态的“功能列表”。它是按顺序叠加的组合。patch 可以替换某个条目的 config，也可以插入新条目，因此最终配置需要从实际 dump-config 判断。

## 核心服务

| 服务 | 作用 |
| --- | --- |
| ctx.sessions | 会话日志、history、fork 和持久化 |
| ctx.systemPrompt | 系统提示词片段和工具 schema 组合 |
| ctx.tools | 面向模型的工具注册表 |
| ctx.agents | 活跃 Agent 和生命周期事件 |
| ctx.agentLoop | 默认 Agent 驱动器 |
| ctx.llm | 消息、流和 Provider seam |
| ctx.fs | 文件系统能力和策略 |
| ctx.shell | Shell 执行后端 |
| ctx.jobs | 后台任务登记和管理 |
| ctx.sandbox | 进程启动前的限制和包装 |

实际版本可能增加、删除或重命名服务。插件作者要以当前源码和生成目录为准；使用者只需要在排错时知道哪个层负责什么。

## 事件域

架构文档区分：

- session 事件：追加到日志、重新加载后仍存在的事实；
- agent 事件：当前活跃 Agent 的输入、步骤、请求、验证和续跑；
- 能力事件：给 fs、tools、llm、telemetry 等 seam 加策略和适配器。

要永久保留的事实写入 session 事件；只观察进行中工作，使用 Agent 或能力事件。不要把实时事件当成持久化事实。

## 轮次、步骤和事件

一个步骤是一次模型请求和它调用的工具。一个轮次可以包含多个步骤：

~~~text
turn/start
  → 领取输入
  → 组装 prompt 和工具 schema
  → agent/pre-step
  → step/start
  → agent/request
  → llm/stream
  → tool/call / tool/result
  → step/end
  → 继续下一步或停止
turn/end
~~~

这解释了为什么一次“发送消息”可能产生多次模型请求和工具调用。结果复核要看事件和外部状态，不能只看一条 assistant 文本。

## 扩展位置

官方架构给出的典型映射：

| 想增加的行为 | 常见位置 |
| --- | --- |
| 模型提供方 | ctx.llm |
| 面向模型的工具 | ctx.tools |
| Shell 后端 | ctx.shell、ctx.subprocess |
| 文件策略 | ctx.fs 或 fs/* |
| 工具拦截 | tools/* |
| 持久会话状态 | SessionEventMap 和日志派生 |
| UI/编辑器集成 | ctx.agents 和 session/event |
| 后台工作 | ctx.jobs |
| Agent 目标 | ctx.goals |

先找现有 seam，再写插件。直接改 agent-loop 会让能力和核心循环强耦合，也更难升级。
