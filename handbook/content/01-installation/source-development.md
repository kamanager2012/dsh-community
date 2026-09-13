# 从源码开发与日常检查

## 什么时候需要源码

源码工作流面向：

- 插件作者；
- 需要阅读或修改 dsh 包的人；
- 需要固定某个 commit 的团队；
- 需要运行仓库示例和开发测试的人；
- 需要向上游提交贡献的人。

普通使用者不必为了启动 Web UI 克隆源码。

## 官方搭建路径

~~~bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
corepack enable
pnpm install
pnpm run typecheck
pnpm run build
pnpm dsh web
~~~

Node、pnpm 和 Git 版本以当前开发指南为准。源码构建和 npm 发布包是两条不同路径，使用前记录入口和 commit。

## 先 typecheck，再 build

typecheck 适合确认源码和类型关系；build 会生成运行时产物并可能需要更多时间。依赖构建产物的示例、打包检查或插件消费测试，先运行 build。

不要把 build 产物、缓存和临时日志混入功能 diff。完成后检查：

~~~bash
git status --short
git diff --stat
~~~

## 源码布局的使用者视角

官方仓库大致分成：

- apps：CLI 和 Web 应用；
- packages：核心服务、插件、工具和组合包；
- docs：架构、子系统、配置和用户指南；
- examples：可运行示例；
- python：Python SDK 与开发工作流；
- scripts：构建、文档和门禁脚本。

目录名称不是稳定 API。读源码时先看相邻 README、package.json 的 dsh 字段和官方架构文档。

## 改源码前的检查点

~~~text
改动包：
所属 aggregate：
提供/消费的 context：
事件分发模式：
权限和数据流：
是否有生成目录：
测试命令：
文档同步：
回滚：
~~~

不要一上来让 Agent 扫描整个仓库。先选定包和行为，再按依赖阅读。

## 贡献者工作流

文档、包、翻译和源码的门禁可能不同。运行与改动直接相关的最小检查，再按上游贡献指南执行完整门禁。不要因为本地某一条命令通过就声称整个仓库通过。
