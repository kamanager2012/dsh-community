# 总览：先把 dsh 想清楚

这一组章节回答三个问题：

1. dsh 是什么，和普通聊天页面、代码补全插件、脚本调用有什么区别；
2. 一次任务由哪些对象组成，为什么 workspace、session、Provider 和权限必须分别处理；
3. 你应该选择 Web UI、Headless CLI、Python SDK 还是插件扩展。

## 推荐阅读路径

- 想理解社区公开仓库如何分工：先读[Community 生态与产品入口](community-ecosystem.md)。冻结 Labs 的历史说明见 [Community Labs handoff](../11-operations/community-labs-handoff.md)。
- 想建立整体判断：先读[五层模型](harness-five-layers.md)，再走[从空白 workspace 到可验收交付](../05-workflows/from-blank-to-delivery.md)。
- 只想第一次用起来：先读[安装与首次启动](../01-installation/README.md)，再读[Web UI 首次任务](../02-web-ui/first-run.md)。
- 想让代理修改代码：读[任务契约](../core/task-contract.md)、[代码修改工作流](../05-workflows/code-change.md)和[权限边界](../06-security/permissions.md)。
- 想接入脚本或 CI：读[Headless CLI](../automation/headless-cli.md)、[CLI 运行与配置](../03-cli/README.md)和[CI 运行手册](../11-operations/ci.md)。
- 想用 Python 控制：读[Python SDK](../automation/python-sdk.md)和[SDK 工程实践](../08-automation/sdk-engineering.md)。
- 想开发插件：先读[架构与插件模型](architecture.md)，再读[插件开发总览](../10-plugins/README.md)和[Cordis 入门](../10-plugins/cordis-primer.md)。

## 本手册的边界

本手册以 DeepSeek Harness 官方仓库的公开资料为基础，做中文解释、使用顺序重排和安全补充。它不替代上游的 API、配置目录和源码参考。

上游项目处于 Developer Preview。命令、配置字段、插件接口和默认组合都可能发生破坏性变化。遇到本文与当前版本不一致时，优先检查：

~~~bash
npx @deepseek-ai/dsh --help
npx @deepseek-ai/dsh web --help
npx @deepseek-ai/dsh --profile headless --help
~~~

如果仍然无法判断，查看对应版本的上游源码和配置导出，不要靠旧文章猜参数。

## 章节地图

| 部分 | 解决的问题 |
| --- | --- |
| [总览](README.md) | dsh 的对象模型和选择路径 |
| [安装与运行时](../01-installation/README.md) | Node、npm、源码构建、Windows/WSL 和升级 |
| [Web UI](../02-web-ui/README.md) | 浏览器使用、工作区、会话、审批和故障处理 |
| [CLI](../03-cli/README.md) | profile、配置导出、headless 和脚本边界 |
| [Provider 与模型](../04-providers/README.md) | DeepSeek、目录 Provider、自定义端点和多模态 |
| [任务工作流](../05-workflows/README.md) | 只读、修复、测试、重构、文档和长任务 |
| [安全](../06-security/README.md) | 权限、沙箱、凭据、数据流和事故处置 |
| [Session 与状态](../07-sessions/README.md) | history、resume、fork、日志和恢复 |
| [自动化](../08-automation/README.md) | SDK、结果、日志、重试和批处理 |
| [工具](../09-tools/README.md) | 文件、搜索、Shell、计划、子 Agent 和图片 |
| [插件与 Cordis](../10-plugins/README.md) | profile、bundle、patch 和扩展开发 |
| [运维](../11-operations/README.md) | 团队规则、CI、升级和问题分诊 |
| [参考](../12-reference/README.md) | 命令速查、模板、术语和来源 |
| [Community 生态](community-ecosystem.md) | 官方 Runtime、Canonical 产品、Labs、Registry 和 Marketplace 的边界 |

## 本章新增的总框架

[五层模型](harness-five-layers.md)把后面的章节串成一条线：先定义指令，再锁定约束，确认实际能力，管理 session 状态，最后用编排和外部验收收口。它是阅读框架，不是 dsh 的新配置字段。

## 阅读记号

正文中会区分三种说法：

- **官方行为**：直接来自上游文档、帮助输出、公开配置或源码说明；
- **操作建议**：为了降低风险而给出的工程做法，不是 dsh 的配置字段；
- **版本注意**：某个行为可能只适用于特定发行版、profile 或组合。

不要把操作建议复制成 dsh 原生配置，也不要把一个 profile 的能力推广到另一个 profile。
