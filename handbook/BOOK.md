---
title: DeepSeek Harness 中文使用手册
subtitle: 从第一次启动到可验收交付
lang: zh-CN
---

# DeepSeek Harness 中文使用手册

## 从第一次启动到可验收交付

这是本项目的书稿入口。`README.md` 负责项目首页和快速启动；本文件负责连续阅读顺序。正文仍以各章节 Markdown 为准，目录不复制章节内容。

本书的定位是：**DeepSeek Harness 工程实施、验收与运维手册**。它不替代官方 API 参考，也不承诺模型、命令或配置字段永久稳定。

## 这本手册要解决什么

DeepSeek Harness（`dsh`）不是把模型接到一个聊天框里就结束了。一次可交付的任务还需要明确：模型能看到什么、能做什么、哪些动作要审批、哪些状态会保存，以及最后由什么外部结果证明完成。

本书围绕一条主线展开：

```text
理解 Harness
  → 启动并配置 dsh
  → 在可恢复 workspace 中建立基线
  → 让 Agent 先读再写
  → 用最小权限完成修改
  → 用 diff、测试和人工检查验收
  → 在需要时恢复、自动化或扩展
```

## 推荐读法

第一次使用者不需要通读全部参考页。先读序章和主线实战，再按实际问题跳转：

1. 理解[五层模型](content/00-overview/harness-five-layers.md)；
2. 走[从空白 workspace 到可验收交付](content/05-workflows/from-blank-to-delivery.md)；
3. 需要具体参数时查[按任务查找用法](content/tasks/index.md)；
4. 需要接入程序、团队或插件时，再读自动化、运维和扩展章节。

本书稿不包含虚构的运行日志、假截图、预填退出码或模型成功率。示例是任务契约、操作步骤和验收模板；运行结果必须由读者自己的环境产生。

# 目录

## 序章：先把 dsh 想清楚

1. [dsh 是什么](content/00-overview/what-is-dsh.md)
2. [五层模型：把 dsh 变成可控的执行系统](content/00-overview/harness-five-layers.md)
3. [心智模型：一次 dsh 运行里到底有什么](content/00-overview/mental-model.md)
4. [什么时候应该使用 dsh](content/00-overview/when-to-use.md)
5. [架构概览](content/00-overview/architecture.md)

这一部分回答：Harness 和普通模型调用有什么区别，以及为什么任务、权限、Provider、工具和 session 不能混成一个概念。

## 第一部：第一次启动与第一次结果

6. [安装与首次启动](content/01-installation/README.md)
7. [npm 包与源码运行](content/01-installation/npm-vs-source.md)
8. [Windows 与 WSL](content/01-installation/windows-wsl.md)
9. [Web UI 首次任务](content/02-web-ui/first-run.md)
10. [工作区与 Session](content/02-web-ui/workspaces-and-sessions.md)
11. [Provider 与模型](content/04-providers/README.md)
12. [DeepSeek Provider](content/04-providers/deepseek.md)

这一部分的交付物不是“模型回复了一句话”，而是服务可访问、模型可选、workspace 正确，并完成一条可检查的低风险任务。

## 第二部：把一次任务做成闭环

13. [主线实战：从空白 workspace 到可验收交付](content/05-workflows/from-blank-to-delivery.md)
14. [任务工作流总览](content/05-workflows/README.md)
15. [只读分析](content/05-workflows/read-only.md)
16. [代码修改](content/05-workflows/code-change.md)
17. [测试与失败定位](content/05-workflows/testing.md)
18. [文档与重构](content/05-workflows/docs-and-refactor.md)
19. [长任务与阶段交付](content/05-workflows/long-tasks.md)
20. [结果复核与验收](content/02-web-ui/result-review.md)

这一部分是全书主线：目标、范围、不变量、权限、停止条件和验收必须在任务开始前就能说清楚。

## 第三部：安全边界与状态恢复

21. [安全使用总览](content/06-security/README.md)
22. [权限与审批](content/06-security/permissions.md)
23. [凭据与数据流](content/06-security/credentials.md)
24. [威胁模型](content/06-security/threat-model.md)
25. [Session 模型](content/07-sessions/model.md)
26. [Session 持久化与事件](content/07-sessions/persistence.md)
27. [恢复与故障运行手册](content/07-sessions/recovery.md)

这一部分回答：任务失控、上下文污染、权限不足或中途失败时，如何保留现场、判断影响并安全恢复。

## 第四部：CLI、工具与自动化

28. [CLI 命令与参数](content/03-cli/commands.md)
29. [Profile、Bundle 与 Patch](content/03-cli/profiles-and-config.md)
30. [Headless 与脚本](content/03-cli/scripting.md)
31. [工具目录与能力边界](content/09-tools/catalog.md)
32. [工具执行流水线](content/09-tools/execution-pipeline.md)
33. [Python SDK 工程实践](content/08-automation/sdk-engineering.md)
34. [批处理与 workspace 隔离](content/08-automation/batch-and-isolation.md)
35. [队列、超时与重试](content/08-automation/queues-and-retries.md)

这一部分把一次人工任务变成可控的脚本或服务，同时保留退出码、外部验收、清理和人工介入路径。

## 第五部：插件、团队与长期维护

36. [插件模型](content/10-plugins/plugin-model.md)
37. [Cordis 入门](content/10-plugins/cordis-primer.md)
38. [Profile、Bundle、Patch 与扩展](content/10-plugins/profiles-bundles-patches.md)
39. [插件调试与发布](content/10-plugins/debugging-and-release.md)
40. [团队使用规范](content/11-operations/team.md)
41. [CI 与发布](content/11-operations/ci.md)
42. [可观测性与故障分诊](content/11-operations/observability.md)
43. [成本与质量](content/11-operations/cost-and-quality.md)

这一部分关注系统如何被多人复用、升级和审计，而不是只在个人电脑上完成一次演示。

## 附录：速查、模板与来源

44. [命令速查](content/12-reference/cheatsheet.md)
45. [完整任务示例](content/12-reference/examples.md)
46. [任务模板](content/12-reference/templates.md)
47. [术语表](content/12-reference/glossary.md)
48. [FAQ](content/12-reference/faq.md)
49. [阅读计划](content/12-reference/reading-plans.md)
50. [官方来源与阅读方法](content/12-reference/sources.md)

附录用于查找和复核，不替代主线章节。遇到版本差异时，以当前安装版本的 `--help`、官方资料和实际验收为准。

## 书稿与运行版本的边界

- `BOOK.md` 是连续阅读目录，不是独立于正文的另一份手册；
- `README.md` 是项目首页，适合快速启动和选择入口；
- `VERSION.md` 记录 dsh 兼容性注意，不承诺永久稳定的命令和字段；
- `evidence/` 与 `labs/` 是维护者附录，不是普通读者的实验结果库；
- 任何命令、退出码、测试结果和模型行为，都必须标明是否在读者自己的环境中实际运行。

## 发布前检查

正式生成网页或 PDF 前，至少检查：

- 目录链接和章节顺序；
- 代码块是否完整、命令是否带版本边界；
- 表格和 Mermaid 图是否能被目标渲染器处理；
- 没有个人路径、真实凭据、虚构日志和未验证成功数字；
- 发布版本、对应 dsh 版本和已知不兼容项是否写清楚。

内容校验命令：

```bash
python3 scripts/validate_handbook.py
```
