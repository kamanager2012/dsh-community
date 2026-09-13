# DeepSeek 官方 Provider

## 在 Web UI 配置

1. 启动 Web UI；
2. 打开 Settings → Models；
3. 在 DeepSeek 卡片输入 API key；
4. 保存；
5. 为新 session 选择模型；
6. 用只读任务做最小验证。

官方文档说明密钥字段是只写的，保存后页面只接收脱敏描述符；密钥保存在 DSH_HOME 下的凭据文件，settings 只保存凭据引用。

## 环境变量方式

自动化或源码示例可以使用环境变量。变量名按当前版本和入口文档为准，常见形式是：

~~~bash
export DEEPSEEK_API_KEY
# 兼容网关按需设置
# export DEEPSEEK_BASE_URL
~~~

示例中不要写真实值。不要把含值的 export 命令提交到脚本、CI 输出或 Markdown。

## 最小验证任务

~~~text
目标：确认当前 Provider 和模型可以完成一次低风险只读请求。
范围：只读取临时 workspace 的 README 和目录清单。
禁止：不写文件、不安装依赖、不联网扩展范围。
输出：列出读取过的文件、观察到的事实和不确定项。
停止：凭据、模型或权限不明确时停止。
~~~

它只验证请求链路，不验证复杂工具、长上下文或代码修改能力。

## 端点差异

如果使用 DeepSeek 兼容网关，明确记录：

- endpoint；
- API protocol；
- 模型 ID；
- 是否支持 streaming；
- 是否支持工具调用；
- 是否支持图片；
- 认证头或其他原生要求；
- 组织的保留和审计策略。

“能返回文本”不代表代码 Agent 所需的工具调用和上下文协议全部兼容。
