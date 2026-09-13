# 自定义端点

## 适用场景

自定义 Provider 常见于：

- 公司内部模型网关；
- OpenAI 兼容服务；
- 本地或局域网模型；
- 代理、审计或路由层；
- 目录中没有的供应商。

配置前先拿到端点的真实接口说明。不要因为 URL 里有 /v1 就假定协议正确。

## 字段清单

| 字段 | 说明 |
| --- | --- |
| Provider ID | 小写、稳定、长期使用 |
| 显示名称 | 面向用户的可读名称 |
| Base URL | 实际请求入口 |
| API protocol | 端点支持的协议 |
| Credential | UI 凭据或环境变量引用 |
| Models | 可调用的模型 ID |
| input/defaultInput | 模型和路由的输入模态 |
| 其他字段 | 按当前 Provider 和配置目录确认 |

## 示例

~~~yaml
llm-pi-ai:
  providers:
    my-gateway:
      apiKeyEnv: GATEWAY_API_KEY
      api: openai-completions
      baseURL: https://gateway.example/v1
      models:
        - id: coding-model
          input: [text]
~~~

这是结构示例，不是可直接使用的 endpoint。不要把 example 域名、模型 ID 或变量名误当作真实服务。

## 验证自定义端点

分层验证：

### 端点层

用端点自己的健康检查或受控客户端确认 DNS、TLS、代理和认证。不要先把真实私有仓库交给 Agent。

### Provider 层

确认 Provider 保存、模型选择器可见、模型 ID 不被改写。若目录查询失败，手动填写模型后继续。

### dsh 层

用只读任务验证模型请求、工具调用和错误处理。模型只会返回文本时，不能直接推断工具协议也兼容。

### 工作流层

在临时 checkout 中运行一个最小代码任务，检查文件编辑、Shell、审批和测试。每一层都失败时，回到该层排错，不要跨层猜测。

## 网关常见问题

- endpoint 路径多一层或少一层；
- protocol 与请求格式不同；
- 认证头由网关改写；
- streaming 被代理缓冲；
- 工具调用字段被丢弃；
- reasoning/content 字段不兼容；
- 超时由多个代理层叠加；
- 图片上传被限制；
- 日志记录了完整 prompt 或响应。

任何一个问题都可能表现为“Agent 不会工作”。保存脱敏的 HTTP 错误、状态码和请求阶段，避免共享密钥和完整私有内容。
