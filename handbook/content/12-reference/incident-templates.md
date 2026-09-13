# 故障与越界报告模板

## 启动失败

~~~text
时间：
入口：
命令：
dsh/Node/Python 版本：
操作系统：
DSH_HOME：
profile：
端口：
退出码：
stdout 摘要：
stderr 摘要：
是否触发模型请求：
下一步：
~~~

## Provider 失败

~~~text
Provider ID：
协议：
模型 ID：
Base URL（脱敏）：
凭据来源：
错误阶段：
HTTP 状态：
是否新建 session 重试：
是否有外部请求：
是否有工作区 diff：
~~~

## 工具越界

~~~text
发现时间：
任务目标：
workspace：
session：
权限：
工具名称：
工具参数（脱敏）：
请求还是已执行：
读取：
写入：
联网：
后台进程：
已采取的动作：
凭据是否可能暴露：
恢复和轮换：
~~~

## 验收失败

~~~text
Agent 状态：
退出码/finish_reason：
代理声称：
实际 diff：
测试命令：
测试退出码：
首个失败：
已排除：
交付状态：
下一步：
~~~

报告只包含定位需要的信息。完整日志、私有代码和凭据放在受控位置，不要贴到公共工单。
