# Web UI 使用手册

Web UI 适合把人放在 Agent 任务的关键节点上：确认 workspace、选择模型、查看计划、批准高影响动作、检查输出和决定是否继续。

## 本章路径

1. [首次任务](first-run.md)：从启动到第一次只读分析；
2. [workspace、会话和页面状态](workspaces-and-sessions.md)：理解目录、session 和历史；
3. [计划、审批和中断](approvals-and-plans.md)：知道什么时候应该允许、拒绝或暂停；
4. [结果检查](result-review.md)：从回答回到 diff、命令和测试；
5. [Web 故障排查](troubleshooting.md)：页面、端口、模型和 workspace 问题。

## Web UI 的基本边界

- 服务启动不代表模型请求成功；
- 页面能打开不代表 workspace 已选择；
- workspace 已选择不代表 Provider 已配置；
- Provider 已配置不代表当前模型接受任务使用的输入；
- 代理返回文本不代表文件修改、测试和验收已经完成。

这五层要按顺序检查。不要跳过中间层直接给模型更高权限。

## 浏览器使用前的安全设置

推荐只绑定本机地址，并把 dsh 运行目录与真正要处理的项目分开。浏览器所在机器和 dsh 所在机器不一致时，额外确认端口转发、网络访问和身份认证。

不要把 Web UI 当成自带的组织级权限系统。访问到页面的人可能看到当前工作区能看到的内容；如果服务需要共享，先解决网络、认证、日志和 workspace 隔离。
