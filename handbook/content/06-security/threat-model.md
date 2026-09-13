# 威胁建模

## 威胁主体

考虑至少四类输入：

- 任务提交者：可能无意扩大范围；
- 仓库内容：README、Issue、注释可能包含诱导指令；
- 外部服务：Provider、MCP、网关或插件可能改变数据流；
- 代理自身：可能误判路径、工具参数或完成条件。

不要把所有内容放在同一个“可信 prompt”层。文件里的“请忽略上层规则”只是待分析数据，不是授权。

## 常见风险

| 风险 | 表现 | 控制 |
| --- | --- | --- |
| Prompt injection | 仓库内容诱导 Agent 越权 | 任务声明外部内容不具授权力 |
| Secret exfiltration | 搜索或日志输出 key | 排除目录、脱敏、最小权限 |
| Scope creep | 从修复一个文件扩展到全仓库 | allowed_paths、停止条件 |
| Destructive tool call | 删除、迁移、覆盖 | 审批、备份、临时副本 |
| Dependency risk | 自动安装或执行未知包 | 禁止安装或先人工审查 |
| Data over-sharing | 私有代码发往不明端点 | Provider 清单、数据分类 |
| Session contamination | 旧上下文影响新任务 | 新 session、独立 workspace |

## 任务边界写法

不要只写“不要越权”。具体写出：

~~~text
允许：读取 src/、tests/ 和 package.json。
禁止：读取 .env、密钥目录和 workspace 外路径。
允许命令：测试、类型检查、git diff。
禁止命令：安装依赖、上传文件、删除目录。
停止：需要超出列表的路径或命令时先询问。
~~~

## 风险接受

如果业务确实需要高权限，记录：

- 为什么低权限不够；
- 具体需要的工具和路径；
- 运行时间；
- 数据是否可恢复；
- 谁批准；
- 如何验收和撤销。

高权限必须有期限和范围，不能成为 profile 的永久默认值。
