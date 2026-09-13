# npm 运行与源码运行

## 通过 npm 运行

npm 方式的优点：

- 不需要管理整个源码仓库；
- 适合快速启动 Web UI 或 headless 任务；
- 版本可以在命令行固定；
- 日常用户不必安装仓库开发依赖。

最小命令：

~~~bash
npx @deepseek-ai/dsh web
~~~

固定版本：

~~~bash
npx --yes @deepseek-ai/dsh@0.1.1-rc.1 web
~~~

这里的版本号只是格式示例，使用时应替换为当前批准版本。先查看包的帮助，不要把示例版本当成永远有效的最新版本。

npx 的缓存、DSH_HOME 和当前工作目录是不同的东西：

- npx 缓存保存包；
- DSH_HOME 保存用户配置、凭据、profile 和可能的 session；
- cwd/workspace 是 Agent 处理的项目。

清理 npm 缓存不会自动清理凭据或 session；删除 DSH_HOME 也不等于卸载 npm 包。

## 从源码运行

源码方式适合：

- 开发或审查插件；
- 需要改动源码并立即重建；
- 需要阅读包之间的组合和配置；
- 需要参与上游贡献；
- 需要复现与某个 commit 绑定的行为。

官方基本路径：

~~~bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
corepack enable
pnpm install
pnpm run build
pnpm dsh web
~~~

如果只是改文档，通常不需要完整构建；如果要运行源码 Web、插件或依赖构建产物的示例，按开发指南执行 typecheck/build。

## npm 版本与源码版本不要混用

常见误判是：从源码看到 package.json 是 A 版本，npx 下载到 B 版本，于是把 A 的行为写成 B 的行为。正确做法是分别记录：

~~~text
运行入口：npm 发布包 / 源码 checkout
发布包版本：实际解析到的 npm 版本
源码 commit：源码方式的固定提交
运行时：Node、Python、平台
profile：web、headless 或自定义
配置：DSH_HOME、patch、Provider
~~~

遇到问题时先确定你到底运行了哪一种，避免拿源码的配置目录去解释 npm 包的错误。

## 源码工作区的安全边界

源码仓库本身是开发工作区，不要让一个 Agent 在同一个目录里同时：

- 修改 dsh 源码；
- 运行需要凭据的模型任务；
- 安装不受审查的插件；
- 生成构建产物；
- 访问含有真实项目秘密的其他目录。

插件开发和模型任务最好使用不同 checkout。真实请求使用隔离 workspace，源码 checkout 只负责构建与测试。
