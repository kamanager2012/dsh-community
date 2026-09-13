# Python SDK 生命周期

## 安装与运行前

创建独立虚拟环境，确认 Python 版本和平台。为每个业务任务准备可恢复 workspace 和独立 session_root。凭据通过受控环境注入，不写进代码。

## 初始化

典型调用包含：

~~~python
from pathlib import Path
from deepseek_harness import DeepSeekHarness

workspace = Path("/absolute/path/to/workspace").resolve()
session_root = Path("/absolute/path/to/sessions").resolve()
composition = Path("/absolute/path/to/composition.cordis.yml").resolve()

with DeepSeekHarness(
    provider="deepseek-official",
    model="MODEL_ID",
    cwd=str(workspace),
    session_root=str(session_root),
    cordis=str(composition),
) as harness:
    result = harness.run(
        "只读检查当前项目并返回依据。",
        session_id="task-001",
    )
~~~

这是接口形态示例。组合、模型和参数按已安装 SDK 和官方示例调整。

## 初始化后检查

程序应在真正运行前检查：

- workspace 存在且属于任务；
- session_root 不在 Git 提交路径；
- session_id 不重复；
- composition 来源可信；
- Provider 配置可用；
- 权限不超过任务要求；
- 日志输出位置可写且受控。

## 运行中

捕获：

- 标准输出和错误；
- SDK 异常；
- finish_reason；
- events 和 notifications 摘要；
- 进程状态；
- workspace diff；
- 外部验收结果。

不要在异常处理器中打印配置对象、环境变量或完整任务文本。

## 同 session 与新 session

同 session 适合继续一个未完成目标，会保留会话和持久 Shell。新 session 适合独立任务、切换 Provider、清除错误上下文或处理敏感输入。

业务数据库中将 session_id 与任务 ID 关联，但不要把用户原文、密钥或完整路径编码进 ID。

## 退出

上下文管理器退出后检查：

~~~text
Agent 是否停止：
子进程是否停止：
后台任务是否停止：
session 是否写完：
workspace 是否需要回滚：
临时目录是否清理：
~~~

程序退出不能替代这些检查。
