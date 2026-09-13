# 图片输入与多模态

## dsh 不会替端点探测能力

手动添加模型在显式声明前按纯文本处理。input 和 defaultInput 是对端点能力的声明，不是健康检查。

如果声明了 image，但端点实际不支持，请求会在 Provider 层失败。不要把配置写上 image 就当作视觉能力已经验证。

## 模型级声明

~~~yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: text-model
        - id: vision-model
          input: [text, image]
~~~

模型自己的 input 只作用于该模型。其他模型没有声明图片时仍按文本处理。

## 路由级回退

如果同一路由下手动添加的模型全部支持图片，可设：

~~~yaml
defaultInput: [text, image]
~~~

它是回退值而不是覆盖值。目录已经描述过的模型，保留目录提供的能力；要收窄某个模型，需要在模型自身设置 input。

## 图片请求排错

### 发送前被拒绝

检查模型的 input、路由的 defaultInput 和当前 Provider 类型。手动模型没有 image 声明时，发送前被拒绝是预期的边界保护。

### Provider 拒绝

这通常意味着声明超出了端点真实能力。移除错误的 image 声明，再开启新 session。

### 为什么要新 session

图片一旦进入 session 日志，旧 session 后续请求可能继续带着它。修好配置后，新 session 可以避免重复发送同一份不兼容输入。

## 隐私与成本

图片可能包含：

- 屏幕上的密钥；
- 用户资料；
- 私有代码；
- 内部地址和凭据；
- 文档或客户数据。

上传前做裁剪和脱敏。记录图片来源和用途，不把原图随意放进构建产物或公共日志。
