# Provider 与模型

Provider 是 dsh 里最容易被低估的一层。模型名只是选择结果的一部分，真正决定请求能否成功的还包括协议、Base URL、凭据引用、模型目录、输入模态和当前 session 的模型记录。

## 本章路径

- [Provider 基础](concepts.md)
- [DeepSeek 官方 Provider](deepseek.md)
- [目录 Provider](catalog-providers.md)
- [自定义端点](custom-endpoints.md)
- [图片与多模态](multimodal.md)
- [凭据和错误排查](troubleshooting.md)

## 推荐配置顺序

~~~text
确认端点
  → 选择 Provider 类型
  → 配置凭据引用
  → 保存 Provider
  → 验证模型 ID
  → 选择模型
  → 用低风险任务验证
~~~

不要一边修改 endpoint、一边换 Provider、一边重试同一 session。一次只改变一个变量。

## 最小配置清单

~~~text
Provider ID：
显示名称：
Base URL：
API protocol：
凭据来源：
模型 ID：
输入模态：
网络边界：
新建 session：
验收命令或结果：
~~~

密钥值不进入清单。只记录变量名或脱敏引用。
