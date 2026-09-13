# DeepSeek Harness 中文使用手册

> 把 DeepSeek Harness 放进真实工程流程的使用与验收指南

搜索和官方文档仍然是最新事实的第一来源。本手册不试图替代它们，而是把分散的事实、风险和操作选择重新组织成中文的可执行路径：先建立边界，再运行任务，最后用外部证据验收。

## 这本手册额外提供什么

| 直接搜索通常给你 | 本手册补上的部分 |
| --- | --- |
| 一个命令、字段或错误码 | 这个信息处于哪一层，下一步先查什么 |
| 多个分散页面 | 从安装、Provider、workspace 到交付的连续路径 |
| “任务完成”的文字描述 | diff、测试、退出码和人工判断组成的验收方法 |
| 某个 session 或模型的局部解释 | history、resume、fork、权限和恢复边界的关系 |
| 能运行的示例 | 允许范围、停止条件、回滚路径和数据风险 |

如果你只需要查一个最新参数，请先看当前版本的 `--help` 和上游资料；如果你需要判断“应该怎样安全地使用、排错或验收”，再从下面的任务入口开始。

## Community 生态入口

DeepSeek Harness Community 不是另一套 Runtime，而是围绕官方 Runtime 的社区增强层。普通用户的正式产品入口只有 [`dsh-community`](https://github.com/kamanager2012/dsh-community/releases/latest)；公开仓库职责、下载边界和已归档 Labs 见[社区生态与产品入口](content/00-overview/community-ecosystem.md)。

维护者如需查阅冻结 Labs 的历史门禁，可读 [Community Labs handoff](content/11-operations/community-labs-handoff.md)。不要把 README、单元测试或 fallback 成功当成真实 Runtime E2E 证据。不要从归档仓安装。

## 从这里开始

- [连续阅读书稿目录](BOOK.md)
- [给 AI 调用的知识包](ai/README.md)
- [English edition：核心使用路径](en/index.md)
- [五层模型：先理解 Harness 如何工作](content/00-overview/harness-five-layers.md)
- [主线实战：从空白 workspace 到可验收交付](content/05-workflows/from-blank-to-delivery.md)
- [按任务查找章节](content/tasks/index.md)

## 遇到问题先看这里

| 现象或目标 | 直接入口 |
| --- | --- |
| dsh 能启动，但任务发不出去 | [FAQ：启动、workspace、Provider](content/12-reference/faq.md) |
| Provider 报 `MISSING_CREDENTIAL`、`UNKNOWN_MODEL` 或 HTTP 错误 | [Provider 故障排查](content/04-providers/troubleshooting.md) |
| 能看到旧消息，但不确定是否真正恢复了 Session | [Session 模型](content/07-sessions/model.md) → [恢复与清理](content/07-sessions/recovery.md) |
| Agent 说完成了，但没有 diff 或不知道能否发布 | [复核与验收设计](content/05-workflows/review-and-acceptance.md) |
| 任务可能改错 workspace、泄露凭据或扩大权限 | [安全使用总览](content/06-security/README.md) → [数据流](content/06-security/data-flow.md) |
| 想把一次任务做成可重复的 CI/团队流程 | [从空白 workspace 到交付](content/05-workflows/from-blank-to-delivery.md) |

## 选择阅读路线

| 你的目标 | 推荐路线 |
| --- | --- |
| 第一次使用 dsh | [安装](content/01-installation/README.md) → [Web UI 首次任务](content/02-web-ui/first-run.md) → [主线实战](content/05-workflows/from-blank-to-delivery.md) |
| 让 Agent 修改代码 | [任务契约](content/core/task-contract.md) → [代码修改](content/05-workflows/code-change.md) → [结果验收](content/02-web-ui/result-review.md) |
| 接入 DeepSeek 或公司网关 | [Provider 与模型](content/04-providers/README.md) → [自定义端点](content/04-providers/custom-endpoints.md) → [Provider 排错](content/04-providers/troubleshooting.md) |
| 接入 CLI、CI 或 Python | [CLI](content/03-cli/README.md) → [自动化](content/08-automation/README.md) → [SDK 工程实践](content/08-automation/sdk-engineering.md) |
| 做安全评审或团队落地 | [安全](content/06-security/README.md) → [Session](content/07-sessions/README.md) → [团队规范](content/11-operations/team.md) |
| 开发插件和扩展 | [插件模型](content/10-plugins/plugin-model.md) → [Cordis 入门](content/10-plugins/cordis-primer.md) → [调试与发布](content/10-plugins/debugging-and-release.md) |
| 让脚本或 Agent 读取结构化正文 | [AI 知识包说明](ai/README.md) → [manifest](ai/manifest.json) → [catalog.jsonl](ai/catalog.jsonl) |

## 阅读原则

- 先读再写，先建立基线再扩大权限；
- Agent 的最终回答不是验收结果，检查真实 diff、测试、退出码和数据流；
- 命令、字段和模型能力以当前版本的 `--help`、上游资料和实际结果为准；
- 示例是任务契约和验收模板，不是虚构的运行记录；
- AI 知识包是静态、可追溯的正文索引，不保证替代实时搜索；
- `evidence/` 和 `labs/` 是维护者附录，普通读者不需要从那里开始。

本网站由仓库中的 Markdown 源稿自动构建；需要查看版本、修改历史或编辑正文时，回到 [GitHub 仓库](https://github.com/kamanager2012/deepseek-harness-handbook)。
