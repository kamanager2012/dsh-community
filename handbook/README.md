# DeepSeek Harness 中文使用手册

[English repository guide](README.en.md) | 简体中文

> 工程实施、验收与运维手册

项目总览：[DeepSeek Harness Community](https://github.com/kamanager2012/dsh-community)。

这是一份面向实际使用者的中文说明，重点是：启动 Harness、配置模型、选择工作区、写出可控的任务，以及检查代理交付的结果。

它是上游文档的中文整理和安全补充，不替代上游项目文档。搜索和上游资料负责提供最新事实；本手册负责把分散信息组织成排错顺序、工作流、风险边界和验收方法。DeepSeek Harness 仍处于快速迭代阶段，使用前请核对你安装的版本和命令帮助。

书稿连续阅读入口：[BOOK.md](BOOK.md)。

在线阅读站：[DeepSeek Harness 中文手册](https://kamanager2012.github.io/deepseek-harness-handbook/)（由 GitHub Pages 自动构建）。

如果你维护的是 DeepSeek Harness Community 生态，请先读[社区生态与产品入口](content/00-overview/community-ecosystem.md)和[当前发行状态](content/11-operations/community-release-status.md)：普通用户只下载 `dsh-community`；Suite、独立 Marketplace 与独立 Plugins 已归档；Edition 已完成代码合流并已归档。冻结 Labs 的历史门禁见 [Community Labs handoff](content/11-operations/community-labs-handoff.md)。

英文入口：[DeepSeek Harness Handbook — English Edition](https://kamanager2012.github.io/deepseek-harness-handbook/en/)。目前有 22 个英文 Markdown 条目（包含首页、翻译状态、生态地图、发行状态和 Labs handoff），优先覆盖 Provider 排错、Session 恢复、复核验收和 FAQ；后续按同一目录继续扩展，不以页数代替质量。

机器可读入口：[AI 知识包说明](ai/README.md)；可直接读取 [catalog.jsonl](ai/catalog.jsonl)，每条记录都带原文和 GitHub 来源。它是静态、可追溯的正文索引，不替代实时搜索和当前版本官方资料。

## 先走一条主线

不要把这份手册当成必须从头读完的参数目录。先用下面三页建立整体判断，再按任务进入专题：

1. [五层模型](content/00-overview/harness-five-layers.md)：理解指令、约束、能力、记忆和编排如何共同决定行动空间；
2. [从空白 workspace 到可验收交付](content/05-workflows/from-blank-to-delivery.md)：完成一次可暂停、可复核、可恢复的任务闭环；
3. [按任务查找用法](content/tasks/index.md)：遇到 Provider、Session、自动化、插件或故障时再跳到对应章节。

本手册不会用虚构实验记录、假截图或预填成功数字来制造厚度。示例是可以复制的任务契约和验收结构；实际命令、退出码、diff 和模型行为必须在你的环境中产生。

## 完整章节地图

这不是只有快速开始的短页；完整内容按以下路径展开：

- [dsh 总览与心智模型](content/00-overview/README.md)
- [安装、源码、Windows/WSL、升级](content/01-installation/README.md)
- [Web UI：首次任务、审批、Session、结果和排错](content/02-web-ui/README.md)
- [CLI：参数、Profile、配置导出、脚本和 Headless](content/03-cli/README.md)
- [Provider 与模型：DeepSeek、目录、自定义端点和多模态](content/04-providers/README.md)
- [任务工作流：只读、修改、测试、文档和长任务](content/05-workflows/README.md)
- [安全：权限、凭据、数据流、威胁和事故响应](content/06-security/README.md)
- [Session 与状态：历史、恢复、Fork、日志和清理](content/07-sessions/README.md)
- [自动化：SDK、结果、隔离、批处理和安全](content/08-automation/README.md)
- [工具：工具目录、执行流水线、Shell 和子 Agent](content/09-tools/README.md)
- [插件与 Cordis：Profile、Bundle、Patch 和扩展](content/10-plugins/README.md)
- [运维：团队、CI、日志和故障分诊](content/11-operations/README.md)
- [参考：命令、模板、术语和官方来源](content/12-reference/README.md)

## 给 AI 工具的入口

如果你希望让 AI 按问题读取本手册，不要把整本正文一次性塞进上下文。使用 [AI 知识包](ai/README.md)：它把 111 篇中文正文和维护中的英文页面拆成带稳定 ID、关键词、原文片段、来源文件和行号的 JSONL 记录。

知识包是从 Markdown 确定性生成的，不是另一套由模型编造的内容。更新正文后运行：

```bash
python3 scripts/build_ai_catalog.py
python3 scripts/validate_ai_catalog.py
```

## 5 分钟开始

### 环境

建议使用 Node.js 22.19+ 或 24+。在终端运行：

```bash
npx @deepseek-ai/dsh web
```

默认访问地址是 `http://127.0.0.1:3080`。需要指定端口时：

```bash
npx @deepseek-ai/dsh web --port 3081
```

也可以先查看当前版本支持的参数：

```bash
npx @deepseek-ai/dsh --help
npx @deepseek-ai/dsh web --help
```

### 配置模型

打开 Web UI 后进入 Settings → Models，配置 Provider 和模型。密钥只写入本机 Harness 的凭据文件，不要粘贴到仓库、任务文本、截图或日志中。

### 选择工作区

先选择一个工作区，再提交任务。第一次使用建议选择干净的临时 checkout 或副本，不要直接把包含密钥、客户资料或未提交重要改动的生产目录交给代理。

## 怎样写任务

任务不要只写“帮我改好”。至少写清楚目标、范围、禁止事项和验收方式。例如：

```text
目标：找出 src/ 中导致测试失败的原因并修复。
范围：只允许修改 src/ 和对应测试；不要改依赖版本。
禁止：不要删除测试，不要访问工作区之外的文件，不要提交 git commit。
验收：运行 npm test 和 git diff --check；最后说明修改的文件、测试结果和未解决问题。
停止：如果需要密钥、联网购买服务或扩大修改范围，先停下来询问。
```

代理完成后，人工检查至少包括：

```bash
git status --short
git diff --stat
git diff --check
```

不要把“代理说完成了”当作验收结果；看实际 diff 和命令输出。

## 自动化使用

### Headless CLI

适合一次性、可脚本化的任务：

```bash
npx @deepseek-ai/dsh --profile headless "在当前工作区运行测试，定位失败原因，只做最小修复；完成后报告修改和测试结果。"
```

Headless 模式返回非零退出码时，应把它当作任务未完成或需要人工介入，而不是忽略错误继续流水线。

### Python SDK

需要把 Harness 集成进 Python 程序时，先安装 SDK：

```bash
pip install deepseek-harness-sdk
```

调用时明确传入工作目录、会话根目录和会话 ID，并把每次运行的 JSONL 日志保存到受控位置。自动化任务应使用临时或可恢复的 checkout；涉及 `danger-full-access` 等高权限配置时，必须运行在隔离环境中。

## 安全边界

- 密钥只通过 Harness 的凭据配置管理，不写进源码、Markdown、YAML、日志或提交记录。
- 默认从最小权限开始；需要写文件、执行命令或联网时，明确允许范围。
- 不把真实生产目录、私有数据和不可恢复的工作区作为首次试验对象。
- 对代理生成的命令、文件修改、依赖变化和网络行为逐项复核。
- 任务超出约定范围、需要额外凭据或验收失败时，停止并转人工处理。

## 快速章节与任务入口

- [五层模型](content/00-overview/harness-five-layers.md)
- [端到端主线实战](content/05-workflows/from-blank-to-delivery.md)
- [按任务查找用法](content/tasks/index.md)
- [任务契约](content/core/task-contract.md)
- [Web UI 快速开始](content/02-web-ui/first-run.md)
- [Provider 快速开始](content/04-providers/README.md)
- [Headless CLI](content/automation/headless-cli.md)
- [Python SDK](content/automation/python-sdk.md)
- [Session 生命周期](content/core/session-lifecycle.md)
- [权限与数据边界](content/06-security/README.md)

`evidence/` 和 `labs/` 是维护者的附录材料，不是普通使用者的必读内容；本手册的结论以对应版本的上游文档、命令帮助和你自己的验收结果为准。

## 本地校验

```bash
python3 scripts/validate_handbook.py
# Windows 可使用：py scripts/validate_handbook.py
```

这个脚本只检查手册链接、YAML 结构和敏感信息模式，不会替你完成模型调用或任务验收。

版本变化见 [VERSION.md](VERSION.md)。

## 许可

本仓库原创的 Markdown 正文、校验脚本和生成的 AI 检索文件按 [MIT 许可证](LICENSE) 提供。这不覆盖上游 DeepSeek Harness 项目、其官方文档，以及手册中引用或链接的第三方资料；它们仍归各自所有者所有，适用各自的许可条款。
