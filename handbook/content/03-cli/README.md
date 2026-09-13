# CLI 使用手册

CLI 主要有三种用途：

- 启动 Web profile；
- 运行一次 headless 任务；
- 查看或覆盖实际的插件组合和配置。

CLI 的参数分为启动器参数、profile 参数和任务位置参数。最容易出错的地方是把它们放错层级。

## 本章路径

- [命令与参数](commands.md)
- [Profile、组合和配置导出](profiles-and-config.md)
- [Headless 运行](../automation/headless-cli.md)
- [脚本与 CI](scripting.md)
- [CLI 故障排查](troubleshooting.md)

## 两种常见形式

~~~bash
npx @deepseek-ai/dsh web
npx @deepseek-ai/dsh --profile headless "执行一个任务"
~~~

第一条启动 Web 应用；第二条启动 headless profile 并把字符串作为任务文本。它们不是同一个运行时的两种显示方式。

## CLI 的安全原则

- 先用 --help 确认当前版本接受什么参数；
- 不把 API key 放到命令行；
- 不把外部文本未经处理地拼进有写权限的任务；
- 每次自动化任务都检查退出码、diff 和独立验收；
- 将 DSH_HOME、workspace 和日志目录明确写入脚本；
- 失败时停止流水线，不要自动放大权限或无限重试。
