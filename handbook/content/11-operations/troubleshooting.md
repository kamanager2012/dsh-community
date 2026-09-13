# 故障分诊

## 先收集最小上下文

~~~text
入口：Web / headless / SDK / 源码
dsh 版本：
Node/Python：
操作系统：
profile：
DSH_HOME：
workspace：
Provider/模型：
权限：
session：
错误阶段：
退出码：
是否有 diff：
~~~

先收集这些，不要先让用户上传全部日志和配置。

## 分层分诊

### 启动层

症状：命令找不到、参数错误、端口或进程失败。

处理：版本、帮助、PATH、Node、端口、DSH_HOME。

### 配置层

症状：profile、bundle、patch 或 Provider 未加载。

处理：配置导出、环境变量、Provider ID、模型 ID、patch 叠加。

### 凭据层

症状：MISSING_CREDENTIAL、401、OAuth/原生认证失败。

处理：引用、变量、权限、账号和 endpoint；不打印值。

### workspace 层

症状：无法输入、找不到文件、改动目录错误。

处理：cwd、workspace、路径格式、权限、符号链接和 Git 基线。

### 工具层

症状：工具不可见、审批等待、命令失败、后台挂起。

处理：工具 schema、权限、沙箱、进程、退出码和工作区 diff。

### 模型/Provider 层

症状：未知模型、协议错误、超时、图片拒绝。

处理：模型 ID、协议、输入模态、端点、网络和新 session。

### 验收层

症状：Agent 说完成但测试/diff 不符合。

处理：独立运行验收器，标记部分完成，不要自动重试或改写状态。

## 升级判断

若升级后只有某一 profile 失败，比较配置和 bundle。若所有 Provider 都失败，先看版本、网络和凭据。若只有一个端点失败，不要回滚整个 dsh；先检查该 Provider 的协议和服务状态。

## 结束条件

排错报告应明确：

- 根因已确认还是仍是假设；
- 是否产生外部请求；
- 是否有文件改动；
- 是否需要轮换凭据；
- 是否可以安全重试；
- 下一步由谁执行。
