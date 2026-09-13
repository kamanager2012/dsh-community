# SDK 工程实践

## 封装一个任务函数

一个业务层函数不应只返回字符串。建议返回结构化状态：

~~~text
status：
session_id：
finish_reason：
final_response：
events_summary：
notifications_summary：
workspace：
diff_summary：
validation：
error：
~~~

这样调用者可以区分模型说“完成”、进程结束、测试通过和业务验收通过。

## 生命周期

使用上下文管理器或等价的显式生命周期：

~~~python
with DeepSeekHarness(...) as harness:
    result = harness.run(task, session_id=session_id)
~~~

不要把一个长寿命 harness 对象随意用于互不相关的任务。复用 runtime 可能保留进程、环境变量、Shell 函数和 session 状态。

## 路径隔离

每个任务至少区分：

- cwd：Agent 工作目录；
- session_root：日志和状态目录；
- 任务输入目录；
- 产物输出目录；
- 临时目录。

不要把 session_root 放到 Git workspace 内，避免日志被提交。不要让多个并行任务共享可写的同一目录。

## 超时和取消

超时处理要回答：

- Agent 进程是否停止；
- 子进程和后台任务是否停止；
- session 是否仍可恢复；
- workspace 是否有半成品；
- 是否应该重试或转人工。

只杀父进程可能留下子进程和文件写入。取消后一定检查进程树和 diff。
