# 添加工具与 Provider

## 先选扩展 seam

| 需求 | 首选 seam |
| --- | --- |
| 增加模型 | ctx.llm 的 Provider/适配器 |
| 增加面向模型的能力 | ctx.tools |
| 增加文件策略 | ctx.fs 或 fs/* 事件 |
| 增加 Shell 后端 | ctx.shell / subprocess |
| 拦截工具执行 | tools/* 事件 |
| 增加会话状态 | SessionEventMap 和日志派生 |
| 增加 Web 节点 | ConversationNodeDefinition 与 renderer |
| 增加后台工作 | ctx.jobs |

不要为了增加一个工具改 Agent loop；先查官方架构和扩展 cookbook 是否已有对应入口。

## 工具设计

工具应定义：

- 稳定名称；
- 清楚描述；
- 严格参数 schema；
- 允许的输入；
- 输出和错误；
- 权限与审批；
- workspace/网络边界；
- 并发和取消；
- 日志和脱敏；
- teardown。

描述不是宣传语。模型依赖描述选择工具，含糊的描述会导致误用。

## Provider 设计

Provider 适配器要分清：

- 配置解析；
- 凭据引用；
- 请求编码；
- streaming；
- tool call；
- multimodal；
- 错误映射；
- 超时和取消；
- 模型目录；
- 日志脱敏。

声明支持某项能力不等于端点真的支持。适配器要在请求阶段处理端点错误，并把错误归因说清楚。

## 公共行为

把插件暴露给普通使用者前，写出：

~~~text
安装/加载方式：
适用 profile：
新增工具：
读取数据：
写入数据：
网络：
凭据：
默认权限：
失败行为：
卸载方式：
兼容版本：
~~~

没有这些说明的插件，即使能运行，也不适合团队使用。
