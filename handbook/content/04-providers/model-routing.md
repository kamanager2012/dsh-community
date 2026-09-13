# 模型路由与能力声明

## 路由的组成

一条模型路由至少包含：

~~~text
Provider
  → 协议
  → Base URL
  → 凭据
  → 模型 ID
  → 输入模态
  → 推理/超时等可选设置
~~~

这些字段共同决定请求。模型 ID 相同而 Provider 或 Base URL 不同，可能是完全不同的服务。

## 默认模型与当前 session

默认模型用于新 session。当前 session 一旦发过请求，通常会保留自己的模型记录。为避免比较混乱：

- 比较模型时每个模型创建新 session；
- 任务报告中记录模型和 Provider ID；
- 不要在旧 session 中假定改默认值会切换历史；
- Provider ID 重命名要迁移引用。

## 能力声明的层级

模型能力可能来自：

- 已安装 Provider 目录；
- Provider 路由的 defaultInput；
- 单个模型的 input；
- 当前端点实际响应；
- profile 提供的工具和系统提示词。

input/defaultInput 只声明输入模态，不会自动探测端点。工具调用、streaming、上下文长度和 reasoning 也要按端点实际协议确认。

## 路由比较

比较两个端点时固定：

- 相同的只读 workspace；
- 相同的任务文本；
- 相同的输入文件；
- 新 session；
- 相同的超时和验收；
- 不把一个结果作为另一个的上下文。

比较维度：

~~~text
请求是否成功
工具调用是否被接受
文件结果是否正确
错误是否可解释
结束原因
延迟和成本
数据流和保留
~~~

不要只用“回答更像人”作为 Provider 选择依据。

## 能力不匹配的处理

如果模型可聊天但不能工具调用，先检查 API protocol 和 Provider 适配器。如果模型可文本但不能图片，检查 input、defaultInput 和端点。如果模型请求成功但工具结果无法继续，检查 tool-call 编码和 streaming。

错误归因应写成“请求阶段/协议/端点/工具”中的一层，而不是笼统写“模型不支持”。
