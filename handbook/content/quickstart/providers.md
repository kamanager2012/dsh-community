# 模型与 Provider：把配置做对

Provider 决定请求发往哪里、使用什么 API 协议、凭据如何引用、有哪些模型，以及模型接受哪些输入。官方字段和界面说明见[Provider 中文指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.zh.md)。

## 配置 DeepSeek

启动 Web UI 后进入 **Settings → Models**，在 DeepSeek 卡片中输入 API key 并保存。

凭据字段是只写的；保存后界面只保留脱敏描述，凭据存放在 `$DSH_HOME/.credentials.yaml`，设置文件只保存引用。因此：

- key 可以输入到 UI，但不能写入仓库；
- 排查时确认凭据引用、环境变量名和目录权限，不要打印 key；
- 共享机器上确认 `$DSH_HOME` 的归属和权限；
- 不把含值的 `export` 命令复制进脚本、截图或日志。

## 使用目录 Provider

选择 **Add Provider**，从已安装目录中选择 Provider，再填写它要求的认证信息。

不要把所有 Provider 都理解成“API key + base URL”两项表单。部分 Provider 使用原生认证，例如 AWS 凭据与区域、ADC 项目、`api-version` 或 OAuth。认证方式以该 Provider 的字段为准。

配置完成后，从模型选择器中选择模型。选择会成为新 session 的默认值；已经发送过请求的 session 会保留自己的模型记录。

## 添加自定义 Provider

公司网关、自建服务或目录中没有的 Provider，使用 **Add Custom Provider**。常见字段如下：

| 字段 | 建议 |
| --- | --- |
| Provider ID | 使用稳定的小写标识，不要把临时环境名写进去 |
| 显示名称 | 面向人的名称，可以修改 |
| Base URL | 填实际请求入口，确认是否需要 `/v1` 等路径 |
| API protocol | 填端点真正支持的协议，不要只看名称猜 |
| Credential | 通过 UI 或环境变量引用，不把值写入配置仓库 |
| Models | 填实际存在、可调用的模型 ID |

Provider ID 会被请求、已保存 session、默认模型和凭据引用使用，应当视为持久标识。需要改名时，新增 Provider、迁移引用，再删除旧 Provider，不要直接改字符串期待旧 session 自动迁移。

模型目录查询只更新表单草稿，保存前不会保存 Provider。查询可能访问当前表单中的 endpoint 和凭据，执行前确认网络边界。

## 配置图片输入

手动添加的模型在显式声明前按纯文本处理。自定义 Provider 的视觉模型可在 `$DSH_HOME/settings.yaml` 中声明输入模态：

```yaml
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
```

`input` 是对端点能力的声明，不是 dsh 的自动探测。声明了端点不支持的图片能力，请求仍会被 Provider 拒绝。若同一路由下的手动模型都支持图片，可以使用 `defaultInput: [text, image]` 作为回退值；需要收窄某个模型时，在模型自身设置 `input`。

如果图片请求已经写入 session 日志，修复配置后应开启新 session，不要让旧 session 重复同一个错误请求。

## 常见错误

| 错误 | 先检查什么 | 不要做什么 |
| --- | --- | --- |
| `MISSING_CREDENTIAL` | 凭据引用、环境变量名和 `$DSH_HOME` 位置 | 把 key 写进任务或日志 |
| `UNKNOWN_MODEL` | Provider 是否保存、模型 ID 拼写和模型选择器 | 只改模型名，不检查端点 |
| 获取模型列表 `401` | key、base URL 和端点是否支持 `GET /models` | 把 401 直接当成 dsh 没有模型 |
| 发送图片前被拒绝 | 模型 `input` / 路由 `defaultInput` | 反复重试不支持的输入 |
| Provider 拒绝图片 | 端点真实能力与配置声明 | 在同一 session 无休止重试 |

配置正确的最低标准是：Provider 已保存、模型 ID 与端点一致、凭据没有泄露、请求产生的网络流量符合预期。
