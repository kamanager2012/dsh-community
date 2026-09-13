# 第三方 Agent 文档对照

> 这是一页文档设计参考，不是 DeepSeek Harness 的事实来源。更新快照：2026-08-16。

[English](../../en/12-reference/third-party-doc-patterns.md) · [来源与阅读方法](sources.md) · [社区生态入口](../00-overview/community-ecosystem.md)

## 为什么要对照

OpenCode、Aider、Pi 等项目已经验证了一些对用户很有帮助的文档组织方式：先让用户完成第一次成功运行，再按配置、会话、扩展、自动化和排障继续深入。

我们借鉴的是信息架构和可执行性，不复制代码、原文、产品命名或未经验证的能力声明。关于 DSH 的命令、字段、版本和 Runtime 行为，仍以当前官方 `--help`、发布包、源码和真实运行结果为准。

## 值得借鉴的模式

| 文档模式 | 对用户的价值 | 我们的落点 |
| --- | --- | --- |
| Quick Start → 首次成功 | 降低第一次启动的认知负担 | `dsh-community` 使用指南、安装与首次任务 |
| 配置与权限按任务解释 | 用户知道“为什么要授权”和“影响什么” | 安全、Provider、工作区和审批章节 |
| 会话、设置、扩展、SDK 分开 | 不把 CLI、Runtime、插件和集成混成一页 | Session、插件、自动化和 Community Labs handoff |
| Troubleshooting 以症状为入口 | 用户从错误信息直接找到下一步 | Provider、CLI、Web、Session 和运维排错 |
| 示例和参考互相链接 | 先照做，再查完整字段 | 工作流、命令速查、模板和 FAQ |

## 参考资料

- [OpenCode Agents](https://opencode.ai/docs/agents/)：Agent、权限和工具边界的组织方式。
- [OpenCode Permissions](https://opencode.ai/v2/docs/permissions)：按动作、资源和效果解释授权规则。
- [Aider Documentation](https://aider.chat/docs/)：安装、使用、Provider、配置和 Troubleshooting 的任务型目录。
- [Pi coding-agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md)：Quick Start、会话、设置、扩展和 CLI 入口。
- [Pi SDK / RPC](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)：把 SDK、进程隔离和 RPC 的适用场景分开说明。

这些链接用于学习公开文档的结构和表达；它们不是 DSH 的兼容性承诺，也不改变官方 Runtime 的所有权边界。

## 对本生态的具体要求

- 正式用户入口只写 `dsh-community`；Suite 必须标成 Labs，Edition 必须标成归档。
- 每个能力都使用 `[REAL]`、`[PARTIAL]`、`[LABS]`、`[PROBE]`、`[UNVERIFIED]` 等证据标签。
- 命令示例必须能在对应版本运行；不确定的 flag 必须引导用户先运行 `--help`。
- 插件文档区分 Registry 的验证元数据、Marketplace 的发现体验和官方安装链。
- 中英文页面保持同一事实、状态和跳转关系；翻译不能悄悄增加能力声明。

## 继续阅读

- [参考资料与阅读方法](sources.md)
- [当前 Community 发行状态](../11-operations/community-release-status.md)
- [任务入口](../tasks/index.md)
- [命令速查](cheatsheet.md)
