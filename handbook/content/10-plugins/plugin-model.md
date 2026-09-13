# 插件模型

## 一切皆插件意味着什么

官方架构把模型适配器、工具注册表、会话日志、Agent loop、Web 应用和运行策略都放进插件树。一个运行中的 dsh 不是一个固定二进制功能列表，而是由若干组合叠加出来的实例。

好处：

- 能替换某个能力提供方；
- 能让不同 profile 拥有不同工具；
- 能在卸载时撤销注册；
- 能把组织策略放在独立层；
- 能把 Web、headless 和其他入口组合起来。

代价：

- 实际行为需要看组合；
- 配置层叠可能覆盖字段；
- 插件之间有依赖和生命周期；
- 内部 seam 变化会影响扩展；
- 默认 profile 不能代表所有 profile。

## Service、Context 和 Event

Cordis 插件通常向共享 context 提供服务，例如：

~~~text
ctx.llm       模型适配器
ctx.tools     工具注册表
ctx.sessions  会话服务
ctx.agents    活跃 Agent
ctx.fs        文件系统后端
ctx.shell     Shell 后端
~~~

其他插件通过稳定的服务键和事件交互，而不是直接强耦合到某个具体实现。

## 生命周期

插件注册通常是可逆副作用：

- 注册服务；
- 增加工具 schema；
- 加入提示词片段；
- 监听事件；
- 打开资源；
- 返回 disposer；
- teardown 时撤销。

如果插件启动进程、打开文件或建立连接，必须设计对应的清理。忘记 disposer 会造成重载、测试和多次运行时资源泄露。

## 使用者如何利用这个模型

使用者不需要阅读所有源码，只需在行为异常时查看：

~~~bash
dsh --profile web --dump-config
~~~

对照当前 profile、bundle 和 patch，确认“这个工具为什么存在”“这个权限从哪一层进来”。
