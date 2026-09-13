# 升级、降级与回滚

## 为什么升级要单独做

官方项目处于 Developer Preview，兼容性变化可能影响：

- CLI 参数和 profile 名称；
- Provider 表单字段和凭据引用；
- 默认工具、权限和沙箱；
- session 日志格式；
- Python SDK 返回字段；
- bundle、patch 和插件加载；
- Web UI 的入口和显示名称。

升级不是只改一个 npm 版本号。它可能改变任务的实际行动空间。

## 升级前清单

在干净或可恢复的 workspace 中保存：

~~~text
dsh npm 版本或源码 commit
Node/Python 版本
DSH_HOME 位置
profile 与实际配置导出
Provider ID、协议和模型 ID
任务模板
验收命令
当前 session 是否需要继续
~~~

对源码运行，再保存 pnpm 版本、锁文件状态和构建命令。

## 分阶段升级

### 阶段一：静态检查

先读取上游 changelog、README、开发指南和当前 profile 参考。检查配置字段是否改名，旧的 patch 是否仍能应用。

### 阶段二：启动检查

在临时 DSH_HOME 中启动 Web 和 headless，查看帮助和配置导出：

~~~bash
npx @deepseek-ai/dsh --help
npx @deepseek-ai/dsh web --help
npx @deepseek-ai/dsh --profile headless --help
npx @deepseek-ai/dsh --profile web --dump-config
~~~

如果当前版本不支持其中某个参数，以该版本帮助为准；不要为了让旧命令通过而盲目加兼容层。

### 阶段三：低风险任务

先运行只读仓库概览，确认：

- workspace 选择仍然正确；
- Provider 和模型选择仍然可用；
- 工具请求和审批符合预期；
- session 能保存并重开；
- 工作区没有未预期 diff。

### 阶段四：正式任务

只有低风险任务和外部验收都通过后，才把新版本接入写入工作流或 CI。失败时保留旧版本运行方式和回滚路径。

## Session 回滚注意事项

不要把新版本打开过的 session 直接当成旧版本可读可写。升级前后可能存在：

- 事件 schema 变化；
- 工具名称变化；
- cwd 或 profile 元数据变化；
- Provider 和模型标识变化；
- 旧的持久 Shell 状态不再适配。

需要保守处理时，导出必要的任务背景，创建新 session，并重新验证 workspace 和权限。不要只复制一个 session ID。

## 配置回滚

为每个版本保留一份不含密钥值的配置快照：

~~~text
DSH_HOME/
  settings.yaml
  profiles/
  cordis.patch.yml
  package-lock 或版本记录
~~~

凭据文件不进入版本库。回滚时先恢复包和配置，再重新输入或引用凭据；不要把旧密钥从备份中直接复制到不受控目录。

## 降级不是万能修复

如果错误来自 Provider 拒绝、网络策略、端点变更或工作区状态，降级 dsh 不会解决根因。先按[故障分诊](../11-operations/troubleshooting.md)定位，再决定是回滚版本、修改配置还是更换任务入口。
