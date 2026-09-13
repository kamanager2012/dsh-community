# 凭据与秘密

## 凭据的三个阶段

~~~text
输入：用户在 UI 或环境中提供
解析：Provider 根据引用取得
使用：请求发送给端点
~~~

这三个阶段都可能泄露。UI 密钥字段只写不代表浏览器截图、shell 历史、环境诊断和模型日志都安全。

## 推荐做法

- 通过 UI 的凭据存储或受控环境变量提供；
- 任务文本只写“需要已配置的 Provider”，不写 key；
- 配置文件只保存变量名或凭据引用；
- 日志保留错误类型和 Provider ID，去除值；
- 共享机器单独设置 DSH_HOME 权限；
- 任务结束后清理临时变量、session 和缓存；
- 轮换曾经暴露过的 key，不要只删除 Markdown 中的那一行。

## 不要做的事

~~~text
不要：
- 将 sk-... 写进示例
- 把完整 export 命令贴到工单
- 用 env、set、printenv 排查时上传全部输出
- 把 .credentials.yaml 提交到 Git
- 让 Agent 读取 .env、SSH key、云凭据目录
- 在错误报告中包含 Authorization header
~~~

## 排查凭据失败

不打印 key 的前提下，检查：

1. 环境变量名称是否正确；
2. dsh 进程是否继承该环境；
3. Provider 是否引用同一个变量；
4. DSH_HOME 是否正确；
5. 凭据文件的所有者和权限；
6. endpoint 是否需要另一种原生认证；
7. 当前 session 是否仍使用旧 Provider。

将结果报告为：

~~~text
Provider ID：
凭据来源：UI / 环境变量 / 原生认证
变量名：
DSH_HOME：
错误类型：
是否发送请求：
~~~

## 发现泄露时

停止任务、撤销或轮换凭据、保留脱敏时间线，并检查 shell history、CI logs、session logs、截图和 Git 历史。删除当前文件不等于泄露已经消失。
