# Provider 故障排查

## MISSING_CREDENTIAL

按顺序检查：

1. 当前 Provider 是否已经保存；
2. UI 中是否有凭据引用；
3. 环境变量名是否拼写一致；
4. dsh 运行进程是否能看到该变量；
5. DSH_HOME 是否与配置凭据的目录相同；
6. 凭据文件权限是否允许当前用户读取。

不要把 key 直接写进任务或日志来验证。

## UNKNOWN_MODEL

检查：

- Provider ID 是否正确；
- 模型是否已经保存；
- 模型 ID 大小写和前后缀；
- 当前 session 是否仍引用删除前的 Provider；
- 自定义 endpoint 是否把模型 ID 改写；
- 模型选择器是否需要新建 session。

## 401、403 和 404

| 状态 | 常见层级 | 检查 |
| --- | --- | --- |
| 401 | 凭据或认证头 | key、OAuth、AWS/ADC、凭据引用 |
| 403 | 账号、区域、权限或策略 | 组织权限、区域、网关规则 |
| 404 | endpoint 路径或模型 | Base URL、/v1、模型 ID、路由 |
| 429 | 限流或预算 | 重试策略、并发、账户限制 |
| 5xx | Provider/网关/模型服务 | 服务状态、超时、请求大小 |

状态码不能单独证明哪一层错了；保留请求阶段、endpoint 的脱敏标识和响应摘要。

## 获取可用模型失败

自定义 Provider 查询模型列表通常需要端点支持 GET /models。没有该接口时手动填写模型，不要为通过目录查询而放宽网络或凭据权限。

## 更换端点后的 session

Provider、模型或协议改变后，最好创建新 session。旧 session 可能保存旧模型、旧图片、旧系统上下文或持久 Shell。继续使用前必须确认其历史和数据边界。

## 最小排错报告

~~~text
dsh 版本：
Node/Python 版本：
Provider ID：
API protocol：
Base URL（脱敏）：
模型 ID：
错误阶段：
HTTP 状态：
退出码：
新建 session 是否仍失败：
是否产生文件改动：
~~~

这比“请求失败了，给你看我的 key”更有用，也更安全。
