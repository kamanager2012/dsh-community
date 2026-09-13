# CLI 故障排查

## 命令层

先执行：

~~~bash
dsh --help
dsh web --help
dsh --profile headless --help
~~~

如果 dsh 不是 PATH 中的命令，使用 npx 或源码仓库的启动命令。不要同时修改 PATH、npm cache 和 DSH_HOME，这会让根因难以判断。

## Profile 层

如果出现未知 profile、bundle 或 patch 错误：

1. 确认 DSH_HOME；
2. 确认 profile 名称；
3. 临时移除本次 overlay；
4. 导出默认配置；
5. 比较 profile patch 和 home patch；
6. 再逐层恢复自定义配置。

把所有 patch 一次性删掉可能丢失信息；先复制配置目录到受控位置。

## Headless 层

如果进程启动后立即退出：

- 先检查 stdout/stderr 和退出码；
- 再判断是缺凭据、未知模型、Provider 请求错误还是任务错误；
- 检查当前 workspace 是否存在且可访问；
- 检查任务文本是否被 shell 截断；
- 检查脚本是否把非零退出码吞掉。

“没有输出”不是一个根因，它可能意味着参数解析失败、日志被重定向、进程在等待输入或任务在模型层失败。

## 配置导出层

--dump-config 能帮助定位组合问题，但它不包含所有外部状态。导出结果仍要和：

- Node/Python 版本；
- 环境变量名称；
- DSH_HOME；
- workspace；
- Provider 端点；
- 当前操作系统；

一起保存。敏感字段要脱敏后再共享。

## 恢复

CLI 的一次 headless 任务与 Web UI 的 session 控制不能自动互换。不要看到 session 文件就假设可以用另一个入口继续。确认当前版本是否公开 resume、session root 和相关参数；不支持时创建新任务并把背景写入文本。

## 最小报告

~~~text
命令：
版本：
profile：
DSH_HOME：
workspace：
退出码：
stderr 摘要：
最终输出摘要：
外部验收：
工作区 diff：
下一步：
~~~

这个报告足以让另一个人继续排查，也不会迫使你分享完整凭据或全部私有代码。
