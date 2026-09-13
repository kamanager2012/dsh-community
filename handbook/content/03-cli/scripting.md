# CLI 脚本与 CI

## 外层脚本应该负责什么

不要把所有逻辑都塞进任务文本。外层脚本负责确定性工作：

1. 创建或检出 workspace；
2. 检查工作区是否干净；
3. 注入受控环境变量；
4. 启动 dsh；
5. 捕获 stdout、stderr、退出码；
6. 运行独立测试和 diff 检查；
7. 生成脱敏交付结果；
8. 清理临时目录。

Agent 负责需要模型判断的观察和修改；脚本负责流程门禁。

## 一个安全的流程骨架

~~~text
输入任务
  → 校验任务是否允许的类型
  → 创建临时 checkout
  → 写入固定任务模板
  → dsh --profile headless
  → 判断退出码
  → 运行验收器
  → 检查 diff、依赖和秘密
  → 归档结果或清理
~~~

不要把用户输入直接放进 shell 命令字符串。使用进程 API 的参数数组或安全的临时文件，并限制任务文本长度、来源和允许的操作。

## 任务状态不要只看一列

建议外层系统至少保留：

| 状态 | 含义 |
| --- | --- |
| started | 进程启动并记录版本 |
| blocked | 凭据、权限或环境前置缺失 |
| running | 任务仍在运行 |
| agent_failed | Agent 以错误原因结束 |
| validation_failed | Agent 结束但外部验收失败 |
| completed | Agent 与外部验收均通过 |
| needs_review | 结果需要人工判断 |

这样可以区分“dsh 没启动”“模型拒绝”“测试失败”和“模型说完成但 diff 不对”。

## 超时、重试和并发

重试策略必须按错误分类：

- 参数或配置错误：修复后重试，不要原样循环；
- 凭据错误：停止并转人工；
- 短暂网络错误：有界重试，并记录次数；
- 模型输出不稳定：调整任务或模型，不要无限重跑；
- 工具产生了写入：先检查 diff，再决定是否重试；
- 外部验收失败：保留 workspace，不能直接删除现场。

并发前要固定每个任务的 workspace、session root、日志文件、预算和清理责任。共享 DSH_HOME 可能带来配置和 session 交叉污染。

## CI 的最小门禁

~~~bash
set -eu
git status --short
dsh --profile headless "$TASK"
test "$?" -eq 0
git diff --check
npm test
git diff --exit-code -- package-lock.json
~~~

示例中的命令需要按项目调整。不要把 test "$?" -eq 0 放在会吞掉前一个退出码的逻辑之后；实际脚本应使用明确的错误处理和日志。

对允许修改的任务，CI 至少上传：

- 脱敏 stdout/stderr；
- dsh 版本和 profile；
- 任务 ID、session ID 的非敏感引用；
- 测试与验收退出码；
- diff 统计和失败文件；
- 清理结果。

## CI 不应该做什么

- 不把生产密钥放进任务文本；
- 不在主分支 checkout 上直接运行高权限 Agent；
- 不让模型自己决定是否通过流水线；
- 不因为一次超时就自动切换到最高权限；
- 不把完整 session 日志上传到公共构建产物；
- 不在未审查的外部文本中接受“忽略上层规则”等指令。
