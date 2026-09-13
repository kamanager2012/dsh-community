# 配置层排查与维护

## 配置从哪里来

一个 dsh 运行的配置可能来自：

1. 发行版默认 bundle；
2. profile 中声明的 bundle；
3. profile 自己的 patch；
4. DSH_HOME 级 patch；
5. 环境变量后备值；
6. 命令行 overlay；
7. Provider、workspace 或 session 的运行时状态。

这些层的优先级和字段合并规则以当前版本为准。不能只打开 settings.yaml 就断言实际运行配置。

## 配置快照

排错时先生成脱敏快照：

~~~text
dsh 版本：
Node/Python：
DSH_HOME：
profile：
bundle：
patch 文件：
环境变量名称：
workspace：
Provider ID：
模型 ID：
权限：
~~~

不要把完整环境变量值、凭据文件或个人路径上传到公共位置。

## 配置导出比较

两次运行需要比较：

- 条目 ID；
- 工具集合；
- Provider 和模型；
- 权限/审批；
- 沙箱/文件系统；
- session/日志；
- Web/headless 入口；
- patch 来源。

配置导出相同，也不代表 workspace、网络或外部服务相同；它只是缩小排查范围。

## 修改配置的顺序

~~~text
复制当前配置
  → 说明目标字段
  → 在临时 DSH_HOME 载入
  → 导出并比较
  → 运行只读任务
  → 运行外部验收
  → 再更新团队配置
~~~

不要在生产 DSH_HOME 中边改边猜。不要用大范围搜索替换重命名 Provider 或权限字段。

## 配置失效时

优先恢复最后一个已知配置，而不是删除所有文件。保留错误版本用于比较；凭据和 session 单独处理，不要为恢复功能而恢复旧 key。
