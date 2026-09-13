# Session 操作手册

## 开始任务

记录：

~~~text
任务 ID：
workspace：
cwd：
Provider/模型：
profile：
权限：
新 session ID：
session_root：
初始 diff：
~~~

不要使用一个看不清归属的旧 session 开始重要任务。

## 继续任务

继续前复核：

1. 目标是否仍然相同；
2. workspace 是否没有被其他人修改；
3. Provider、模型和权限是否仍然正确；
4. 最后一个 turn 是否完整；
5. 持久 Shell 是否带有不应继承的变量；
6. session 日志是否包含不应继续发送的输入。

任何一项不确定，就新建 session。

## Fork 任务

Fork 前记录父 session 的完成边界和当前 diff。Fork 后分别保存 parent、child 和 workspace 状态。不要把父子两个 session 指向同一个可写目录，除非并发和冲突由外层系统控制。

## 结束任务

结束时确认：

~~~text
Agent 是否停止：
后台任务是否停止：
session 是否 flush：
workspace diff：
测试结果：
最终状态：
日志保留：
临时文件：
~~~

## 会话清理

只清理已确认不再需要的 session 和临时文件。对用户工作区和已有改动先做归属检查。删除 session 不会撤回 Provider 已收到的数据，也不会自动回滚 workspace。
