# 常见问题

## dsh 能启动，为什么任务不能发？

Web UI 需要先选择 workspace；没有 workspace 时输入框可能不可用。若 workspace 已选，再检查 Provider、模型和凭据。

## 能看到网页，是否说明模型可用？

不能。页面可访问只说明服务和路由可达；模型请求还要经过 Provider、凭据、模型 ID、网络和端点。

## 为什么改了默认模型，旧会话没变？

已发送请求的 session 通常保留自己的模型记录。用新 session 验证新默认模型，不要混用历史。

## MISSING_CREDENTIAL 怎么办？

检查 Provider 的凭据引用、环境变量名、进程环境和 DSH_HOME。不要打印 key。详见 Provider 排错。

## 为什么获取模型列表失败？

自定义端点可能不提供 GET /models，或 key、Base URL、认证错误。手动填写模型 ID，并验证实际请求。

## 图片模型为什么仍被拒绝？

手动模型需要声明 input；声明只是能力断言。端点不支持时仍会拒绝。修好后用新 session，避免旧图片重复发送。

## 任务说完成但没有 diff？

可能任务是只读、权限是只读、编辑工具失败、路径不在 workspace 或 Agent 只生成了计划。检查工具结果和实际 diff。

## 测试命令通过，为什么不能发布？

测试只证明该命令通过。还要看完整 diff、依赖、数据流、版本、文档、许可证、部署和人工验收。

## 能否直接用最高权限？

不建议。先把 workspace、任务、工具和验收缩小；高权限只在隔离、可丢弃环境中使用。

## 为什么要新 session？

旧 session 可能保留模型、图片、持久 Shell、错误上下文和工具事件。目标、Provider、workspace 或权限改变时，新 session 更容易解释。

## 可以把 dsh 当普通聊天 API 吗？

可以使用模型请求能力，但 dsh 的主要价值在 Agent、工具、session、权限和组合。只做问答时普通 API 可能更简单。

## 可以把 Web UI 暴露到公网吗？

不要直接暴露。需要远程使用时，先设计认证、TLS、网络、workspace 隔离、日志和停机路径。

## Skill 和手册是什么关系？

Markdown 手册面向人，Skill 面向 Agent 的自动执行规则。先维护手册正文，再从稳定流程派生 Skill；不要把未稳定的实验记录直接写成 Skill 行为。
