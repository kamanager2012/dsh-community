# 任务入口：我想用 dsh 做什么？

这里是用户入口，不复制正文。选择最接近目标的一行，然后按对应章节准备 workspace、权限、Provider 和验收方式。

| 我想…… | 先看 | 完成后检查 |
| --- | --- | --- |
| 从第一次启动走到一次完整交付 | [五层模型](../00-overview/harness-five-layers.md)、[主线实战](../05-workflows/from-blank-to-delivery.md) | 基线、权限、diff、外部验收和恢复点都可解释 |
| 了解 dsh 适合做什么 | [dsh 是什么](../00-overview/what-is-dsh.md) | 选定 Web、CLI、SDK 或插件路径 |
| 第一次跑起来 | [安装](../01-installation/README.md)、[Web UI 首次任务](../02-web-ui/first-run.md) | 服务可访问、模型已配置、workspace 已选择 |
| 只读分析一个仓库 | [只读工作流](../05-workflows/read-only.md) | 无未预期 diff，结论能回到文件或命令 |
| 让 Agent 修改代码 | [代码修改](../05-workflows/code-change.md)、[权限](../06-security/permissions.md) | diff、测试、依赖和未解决问题已检查 |
| 配置 DeepSeek | [DeepSeek Provider](../04-providers/deepseek.md) | 凭据引用、模型 ID 和低风险请求明确 |
| 接入公司网关 | [自定义端点](../04-providers/custom-endpoints.md) | 协议、endpoint、网络和数据流确认 |
| 使用图片输入 | [多模态](../04-providers/multimodal.md)、[工具目录](../09-tools/catalog.md) | 模型声明和端点真实能力一致 |
| 排查 MISSING_CREDENTIAL | [Provider 排错](../04-providers/troubleshooting.md) | 不暴露 key，确认引用、变量和 DSH_HOME |
| 在终端执行一次任务 | [CLI](../03-cli/README.md)、[Headless](../automation/headless-cli.md) | stdout、退出码、diff 和验收已处理 |
| 接入 CI | [CLI 脚本](../03-cli/scripting.md)、[CI](../11-operations/ci.md) | workspace、session、日志、预算和清理隔离 |
| 用 Python 驱动 | [Python SDK](../automation/python-sdk.md)、[SDK 工程](../08-automation/sdk-engineering.md) | cwd、session_root、结果和异常被接管 |
| 跑长任务 | [长任务](../05-workflows/long-tasks.md)、[Session](../07-sessions/README.md) | 检查点、恢复条件、diff 和测试已保留 |
| 排查工具行为 | [工具流水线](../09-tools/execution-pipeline.md)、[工具边界](../09-tools/boundaries.md) | 区分 schema、审批、执行和外部结果 |
| 固定团队运行方式 | [Profile 与 Patch](../03-cli/profiles-and-config.md)、[团队规范](../11-operations/team.md) | 版本、权限、Provider、回滚和 owner 明确 |
| 开发插件 | [插件模型](../10-plugins/plugin-model.md)、[Cordis](../10-plugins/cordis-primer.md) | seam、生命周期、权限、卸载和兼容性明确 |

## 统一任务卡

无论从哪个入口开始，都先填：

~~~text
目标：
workspace：
Provider/模型：
允许修改的范围：
不允许的操作：
允许的网络：
验收命令或检查：
失败时停止条件：
需要保留的 session / 日志：
交付格式：
~~~

如果一个任务无法填出验收条件，它还没有准备好交给 Agent。

## 按现象找答案

| 你看到的现象 | 先排查 | 不要先做什么 |
| --- | --- | --- |
| dsh 能启动，但任务输入不可用 | [常见问题](../12-reference/faq.md)、workspace 选择、Provider 和模型 | 不要直接重装或切换最高权限 |
| `MISSING_CREDENTIAL` | [Provider 排错](../04-providers/troubleshooting.md)中的凭据引用、进程环境和 `DSH_HOME` | 不要把 key 打进任务或日志 |
| `UNKNOWN_MODEL` 或模型列表为空 | [Provider 排错](../04-providers/troubleshooting.md)中的 Provider、模型 ID、endpoint 和新 session | 不要仅凭网页能打开就判断模型可用 |
| 页面停了，但后台是否仍在运行不清楚 | [Session 恢复与清理](../07-sessions/recovery.md) | 不要用清理命令掩盖现场 |
| Agent 说完成了，但没有可交付结果 | [复核与验收](../05-workflows/review-and-acceptance.md) | 不要把最终回答当成验收证明 |
| 测试通过，但仍不确定能否发布 | [复核与验收](../05-workflows/review-and-acceptance.md)、[FAQ](../12-reference/faq.md) | 不要忽略 diff、依赖、数据流和人工判断 |

这些入口是组织过的排查路径，不是对当前版本命令和 Provider 行为的永久承诺；发生版本敏感问题时，回到[官方来源与阅读方法](../12-reference/sources.md)核对。
