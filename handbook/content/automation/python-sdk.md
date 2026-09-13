# Python SDK：程序化驱动 dsh

Python SDK 用来在程序中管理 Harness 的 workspace、session、Agent 组合、持久化事件和生命周期。官方前置条件和示例见[Python SDK 中文指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.zh.md)。

## 前置条件和安装

官方指南要求 Python 3.10+、Git，以及 Linux x64、Linux arm64 或 macOS 14+ arm64。还需要一个兼容的模型端点、凭据和可隔离的 workspace。

在独立虚拟环境中安装：

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install deepseek-harness-sdk
```

安装后的 SDK runtime 不要求系统 Node.js；如果从源码构建运行时，则按源码仓库的开发要求操作。

凭据通过环境管理器注入，示例只写变量名：

```bash
export DEEPSEEK_API_KEY
# 兼容网关按需设置对应的 endpoint 变量
```

不要把含值的 `export` 命令复制进共享脚本、终端录屏或日志。

## 三个路径参数

| 参数 | 作用 | 使用建议 |
| --- | --- | --- |
| `cwd` | Agent 可访问的工作目录 | 每个任务指向隔离 workspace |
| `session_root` | 保存会话日志和状态的目录 | 放在不会提交、权限受控的位置 |
| `session_id` | 一段对话和持久 Shell 状态的标识 | 独立任务使用新 ID；需要延续才复用 |

复用同一个 session 可能保留 Bash 的工作目录、环境变量和 shell 函数。把 session ID 当作状态句柄，不要当作普通请求 ID。

## 基本调用形态

下面是官方接口形态的最小示例；请用实际 Provider、模型、工作区和 composition 路径替换占位符：

```python
from pathlib import Path

from deepseek_harness import DeepSeekHarness

workspace = Path("/path/to/disposable/workspace").resolve()
sessions = Path("/path/to/session-root").resolve()
composition = Path("/path/to/agent-composition.cordis.yml").resolve()

with DeepSeekHarness(
    provider="deepseek-official",
    model="MODEL_ID",
    cwd=str(workspace),
    session_root=str(sessions),
    cordis=str(composition),
) as harness:
    result = harness.run(
        "只读检查项目的测试入口并返回依据。",
        session_id="task-001",
    )

print(result.final_response)
```

SDK 对象在上下文管理器退出时释放运行时资源。每个长任务或批处理作业都应明确创建和销毁边界，避免一个长寿命对象意外承载不相关任务。

## 不要只打印最终回答

`RunResult` 通常包含以下类型的信息，具体字段以安装版本的 SDK 文档为准：

| 字段 | 用途 |
| --- | --- |
| `session_id` | 关联同一 session 的多次运行 |
| `final_response` | 作为交付文本展示 |
| `finish_reason` | 区分正常完成、限额、错误等结束原因 |
| `events` | 查看根 session 的消息、工具和结束事件 |
| `notifications` | 观察根 session 及已发现后代的通知 |
| `session_root` | 检查持久化状态保存位置 |

验收时同时检查结束原因、事件摘要、异常或进程状态，以及 workspace diff。最终文本不能单独证明工具动作成功，也不能证明后代任务全部完成。

## 权限和隔离

官方示例可能包含较宽的本地执行能力。接入服务前：

1. 审查 composition 中的工具、沙箱、权限和持久化配置；
2. 把 workspace 限制在临时 checkout、容器或其他可恢复环境；
3. 为 session 使用可关联但不含敏感信息的 ID；
4. 保存脱敏的结果和事件摘要；
5. 用独立验收器检查 diff、测试和交付物；
6. 只有在单任务稳定后再考虑复用运行时和并发。

如果在 Windows 上使用，先核对具体组合是否依赖 POSIX PTY；不要默认所有 SDK 能力都跨平台等价。
