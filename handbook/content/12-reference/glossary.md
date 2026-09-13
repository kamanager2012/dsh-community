# 术语表

| 术语 | 含义 |
| --- | --- |
| Agent | 在 session 中接收输入、请求模型、调用工具并推进任务的执行主体 |
| Agent loop | 处理输入、模型响应、工具结果和下一步的循环 |
| bundle | 可分发的组合配置及其挂载代码 |
| cwd | 进程或 Agent 的当前工作目录 |
| Cordis | dsh 底层的插件框架 |
| DSH_HOME | 保存 dsh 用户配置、凭据、profile 和状态的目录 |
| Provider | 把模型、协议、端点和凭据接起来的配置对象 |
| profile | 具名的运行时组合 |
| patch | 对插件配置树进行替换或插入的覆盖 |
| workspace | Agent 任务使用的项目工作区 |
| session | 会话事件、历史、模型、状态和恢复边界 |
| turn | 从输入领取开始到没有待处理工作的一个轮次 |
| step | 一个模型请求及其工具调用链 |
| tool schema | 向模型声明工具名称、描述和参数的结构 |
| headless | 不启动 Web server、直接运行一次 Agent 任务的 CLI profile |
| history | 从持久事件中读取的历史视图 |
| resume | 在同一 session 上恢复或继续运行 |
| fork | 从父 session 的完成边界创建 child session |
| MCP | 一种向 Agent 提供外部工具或资源的协议/集成方式 |
| PTY | 伪终端，用于持久 Shell 或交互式进程 |
| sandbox | 限制进程访问、写入、网络或执行范围的机制 |
| approval | 在高影响动作前请求人的允许 |
| DSH permission mode | dsh 对读写、命令和工具请求的权限预设或策略 |
| finish_reason | 一次 Agent 运行结束的原因 |
| JSONL | 每行一个 JSON 对象的日志格式 |
| seam | 可替换能力的接口、提供方和消费者组成的扩展边界 |
| service | Cordis context 中可被其他插件使用的能力 |
| disposer | 在插件卸载时撤销注册、关闭资源的清理函数 |
| Canonical Product | 对用户公开的唯一正式产品；当前是 `dsh-community` |
| Community Labs | 已归档实验区；历史仓是 `deepseek-harness-suite`，不要从那里安装 |
| Compatibility Registry | 记录插件版本、验证线和兼容状态的注册表；当前是 `dsh-community/packages/marketplace/catalog.json` |
| Discovery / Distribution UX | 浏览、搜索和进入官方安装链的用户体验；当前是 `dsh-community/packages/marketplace` |
| Reality Gate | 让 Labs 能力进入正式产品前必须通过的真实运行、契约、安全、E2E 和失败路径门禁 |
| SessionEvent | 官方 Runtime 用于表达 Session 生命周期和事件数据的结构；社区适配器应读取 `event.type` 与 `event.data` |

术语的具体字段和 API 以当前版本官方文档为准。
