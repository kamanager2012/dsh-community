# Provider 迁移与替换

## 迁移的对象

迁移可能只改一个模型，也可能同时改：

- Provider ID；
- API protocol；
- Base URL；
- 凭据来源；
- 模型 ID；
- 输入模态；
- 工具调用协议；
- session 默认值；
- profile patch；
- 数据保留策略。

先明确迁移范围，不要把“换 endpoint”当成所有字段都不变。

## 迁移前清单

~~~text
旧 Provider ID：
新 Provider ID：
旧协议：
新协议：
旧模型：
新模型：
认证方式：
工具调用：
streaming：
图片：
session 处理：
回滚：
~~~

密钥值不写入迁移文档。旧 Provider 是否删除，要等历史 session 和运行中的任务处理完。

## 双写/双路验证

如果业务允许，先保留旧路由，创建新 Provider 和新 session：

1. 用相同的只读任务比较连通性；
2. 比较文本、工具调用和错误；
3. 比较外部验收；
4. 检查数据流和日志；
5. 在低风险项目中运行一次写入任务；
6. 再切换默认值。

不要在同一个 session 中先用旧 Provider 再用新 Provider 做结论比较。

## 常见迁移失败

- 新端点支持文本但不支持工具；
- 模型 ID 不同，Provider 目录无法发现；
- OAuth/原生认证与 API key 方式不同；
- Base URL 多一层或少一层；
- streaming 被代理缓冲；
- 图片能力声明与端点不一致；
- 旧 session 仍引用旧 Provider；
- 旧 patch 覆盖了新字段。

## 回滚

回滚优先恢复：

~~~text
profile/patch
  → Provider 默认值
  → 任务入口
  → 新建 session
  → 外部验收
~~~

如果新 Provider 已经收到私有数据，回滚 dsh 不会撤回外部数据；还要按 Provider 和组织流程处理保留、删除和凭据轮换。
