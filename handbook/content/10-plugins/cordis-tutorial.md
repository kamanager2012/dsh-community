# Cordis 实践教程

## 从一个最小插件开始

一个最小插件要解决四件事：

1. 什么时候挂载；
2. 依赖哪些 context service；
3. 注册什么能力；
4. 什么时候撤销。

伪代码结构：

~~~typescript
const plugin = {
  inject: ["tools"],
  apply(ctx) {
    const dispose = ctx.tools.register(schema, handler)
    return () => dispose()
  }
}
~~~

实际 API 以当前 Cordis 和 dsh 包为准。这里展示的是生命周期思想，不是可以直接复制的发布代码。

## 添加事件监听

先确认事件的 dispatch mode，再决定监听器是否调用 next。观察型监听器不应偷偷改写决策；策略型监听器要说明短路条件。

~~~text
注册
  → 接收事件
  → 检查输入
  → 观察 / 修改 / 拒绝
  → 委托或短路
  → 返回结果
  → teardown
~~~

## 注册提示词和工具 schema

模型看到的提示词和工具 schema 需要稳定、简洁和可操作。新增工具时同时写：

- 工具描述；
- 参数；
- 失败；
- 权限；
- 结果；
- 取消；
- 数据流。

不要靠一段长 system prompt 掩盖工具行为的真实边界。

## 资源清理

插件如果打开：

- 文件；
- Socket；
- 子进程；
- 端口；
- 监听器；
- 定时器；
- 临时目录；

都要在 disposer 中关闭。重复 reload 是最容易发现资源泄露的方式。

## 测试层次

按成本从低到高：

1. schema 和类型检查；
2. 插件挂载/卸载；
3. 配置导出；
4. 工具参数和错误；
5. 沙箱/权限；
6. session 事件；
7. Web/CLI 集成；
8. 真实 Provider 请求。

没有完成高层测试时，只声称低层能力通过。
