# SDK 结果、事件与错误

## RunResult 的角色

官方 SDK 形态会提供 session_id、final_response、finish_reason、events、notifications、session_root 等结果信息。字段的具体集合和类型以安装版本的 SDK 参考为准。

字段的用途不同：

- final_response：给用户看的交付文本；
- finish_reason：本次运行如何结束；
- events：根 session 的持久事件；
- notifications：根 session 和已发现后代的通知；
- session_root：状态所在位置。

不要用 final_response 非空判断成功。

## 错误分类

~~~text
参数错误       启动前失败
凭据/Provider  请求前或请求中失败
模型错误       模型返回或协议失败
工具错误       工具参数、权限或进程失败
运行时错误     SDK、JSONL 或子进程失败
验收错误       Agent 结束但测试/diff 不通过
~~~

每类错误的重试策略不同。SDK 层抛出的异常不应被一个宽泛的 except 吞掉后返回“完成”。

## 结果校验

~~~python
if result.finish_reason != "completed":
    raise RuntimeError("agent did not complete")

# 外部检查 workspace、测试、diff 和产物
~~~

这里的代码只是控制流示例，具体 finish_reason 枚举以安装版本为准。外部验收仍需要在程序中执行，而不是让 Agent 自己声称测试通过。

## 事件摘要

摘要至少保留：

- 事件类型和顺序；
- 工具调用数量与失败；
- turn/step 结束原因；
- 是否出现子 Agent 或后台任务；
- 异常类型；
- workspace diff；
- 测试退出码。

共享摘要时去掉任务原文、私有路径、命令中的秘密和完整工具输出。
