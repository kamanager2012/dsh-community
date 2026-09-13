# 手册正文

这里是 DeepSeek Harness 中文手册的正文入口。内容按使用顺序组织：先启动和配置，再定义任务，最后处理自动化、会话和权限。

这套正文不与搜索引擎竞争“最新字段是什么”。它更适合回答：一个事实放在整个运行链路的哪一层、遇到故障应该按什么顺序缩小范围、怎样把 Agent 的输出变成可验收的工程结果。

连续阅读请从仓库根目录的 [BOOK.md](../BOOK.md) 开始；本页适合按主题跳转。

如果你是带着问题来的，先打开[任务入口](tasks/index.md)，按现象而不是按章节名称找答案。

## 主线入口

如果你第一次读，不要先打开所有章节。先读[五层模型](00-overview/harness-five-layers.md)，再按[主线实战](05-workflows/from-blank-to-delivery.md)走一条从基线、只读、计划、修改到验收的完整路径。

## 推荐阅读顺序

1. [dsh 是什么](00-overview/what-is-dsh.md)
2. [五层模型](00-overview/harness-five-layers.md)
3. [安装与首次启动](01-installation/README.md)
4. [Web UI 首次任务](02-web-ui/first-run.md)
5. [主线实战](05-workflows/from-blank-to-delivery.md)
6. [Provider 与模型](04-providers/README.md)
7. 需要自动化、恢复或扩展时，再看 [自动化](08-automation/README.md)、[Session](07-sessions/README.md) 和 [插件](10-plugins/README.md)

## 章节索引

| 入口 | 适合解决的问题 |
| --- | --- |
| [dsh 总览](00-overview/README.md) | 选择入口、理解运行时对象和定位层级 |
| [安装与平台](01-installation/README.md) | npm、源码、Node、Windows/WSL 和升级 |
| [Web UI](02-web-ui/README.md) | 浏览器任务、workspace、审批和结果复核 |
| [CLI](03-cli/README.md) | 参数、profile、配置导出、headless 和脚本 |
| [Provider 与模型](04-providers/README.md) | DeepSeek、目录、自定义端点和多模态 |
| [任务工作流](05-workflows/README.md) | 只读、修改、测试、文档和长任务 |
| [安全](06-security/README.md) | 权限、凭据、数据流、威胁和事故 |
| [Session](07-sessions/README.md) | 历史、恢复、fork、日志和清理 |
| [自动化](08-automation/README.md) | SDK、结果、隔离、批处理和重试 |
| [工具](09-tools/README.md) | 工具目录、流水线、Shell、文件和子 Agent |
| [插件与 Cordis](10-plugins/README.md) | profile、bundle、patch 和扩展开发 |
| [运维](11-operations/README.md) | 团队规则、CI、日志和故障分诊 |
| [参考](12-reference/README.md) | 命令、模板、术语和官方来源 |

## 完整阅读路径

当前完整正文分为以下部分：

| 部分 | 入口 | 内容 |
| --- | --- | --- |
| 总览 | [dsh 是什么](00-overview/what-is-dsh.md) | 运行时对象、架构、入口选择 |
| 安装 | [安装与首次启动](01-installation/README.md) | npm、源码、Windows/WSL、升级 |
| Web | [Web UI](02-web-ui/README.md) | 首次任务、workspace、审批、结果、排错 |
| CLI | [CLI](03-cli/README.md) | 参数、profile、配置导出、脚本、headless |
| Provider | [Provider 与模型](04-providers/README.md) | DeepSeek、目录、自定义端点、多模态 |
| 工作流 | [任务工作流](05-workflows/README.md) | 只读、修改、测试、文档、长任务 |
| 安全 | [安全使用](06-security/README.md) | 权限、凭据、数据流、威胁、事故 |
| Session | [Session 与状态](07-sessions/README.md) | history、resume、fork、日志、恢复 |
| 自动化 | [自动化](08-automation/README.md) | SDK 工程、结果、隔离、批处理 |
| 工具 | [工具与 Agent 行动](09-tools/README.md) | 工具目录、流水线、文件、Shell、子 Agent |
| 插件 | [插件与 Cordis](10-plugins/README.md) | 插件模型、profile、bundle、patch、扩展 |
| 运维 | [运维与团队使用](11-operations/README.md) | 团队规范、CI、日志、分诊 |
| 参考 | [参考资料](12-reference/README.md) | 命令、模板、术语、官方来源 |

## 阅读原则

- 命令和配置以你安装版本的 `--help`、上游文档和实际输出为准。
- “代理完成”不是验收结果；检查 diff、测试、退出码和未解决问题。
- 涉及写入、执行命令或联网的任务，先明确权限和停止条件。
- 不把密钥、私有数据或不可恢复的生产工作区交给首次任务。

仓库根目录的 `evidence/` 和 `labs/` 属于维护者附录，不是普通使用者的必读路径。
