# Provider 高级设置

## 配置目录

上游配置目录会列出支持的字段和默认值。它比博客中的示例更可靠，但仍要与当前发布包或源码版本对应。

阅读字段时区分：

- 必填；
- 默认；
- 仅某个 Provider 支持；
- 仅某个 profile 读取；
- 仅在模型目录或 UI 中生效；
- 只是提示词或 UI 元数据。

不要把所有 YAML 字段都复制到个人配置。最小配置更容易升级。

## modelOverrides

目录 Provider 没有手写 models 列表时，模型输入能力等覆盖项可能按模型 ID 写入 modelOverrides：

~~~yaml
llm-pi-ai:
  providers:
    anthropic:
      modelOverrides:
        model-id:
          input: [text]
~~~

示例只说明结构。模型 ID、Provider ID 和字段按当前配置目录核对。覆盖项通常只改变声明，不负责探测端点。

## defaultInput 与 input

优先级要明确：

- 目录记录的能力；
- Provider 路由的 defaultInput；
- 具体模型的 input；
- 当前端点实际能力。

defaultInput 是回退值，不是无条件覆盖。模型自身的 input 用来对单个模型作更窄或更明确的声明。

## 推理、上下文和超时

模型请求还可能有：

- 最大输出；
- 推理开关或预算；
- streaming；
- 上下文压缩；
- 工具调用；
- 单次和总超时。

这些字段可能来自 Provider、profile、SDK 参数或任务运行时。记录实际生效来源，不要把一个 SDK 示例参数当成 Web UI 的同名字段。

## 高级配置的验收

任何高级字段都经过：

1. 配置能被当前版本加载；
2. dump-config 显示预期；
3. 新 session 使用该设置；
4. 低风险请求能观察到差异；
5. 错误路径仍可解释；
6. 回滚到默认配置不残留旧 session 状态。
