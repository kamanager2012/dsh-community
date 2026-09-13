# 插件、Profile 与 Cordis

官方项目采用“一切皆插件”的架构。普通使用者不需要一开始就写插件，但理解插件模型能解释为什么 profile、bundle、patch、工具和权限会影响行为。

## 本章路径

- [插件模型](plugin-model.md)
- [Cordis 入门](cordis-primer.md)
- [Profile、Bundle 与 Patch](profiles-bundles-patches.md)
- [添加工具和 Provider](adding-capabilities.md)
- [插件调试与发布](debugging-and-release.md)
- [MCP 集成指南](mcp-integration-guide.md)

## 什么时候需要插件

适合做插件的需求：

- 新的模型 Provider 或协议适配；
- 新的工具和执行后端；
- 文件、Shell、沙箱或审批策略；
- session 存储或事件策略；
- Web UI 节点；
- 组织级默认组合。

不适合做插件的需求：

- 一次任务的目标；
- 一段只在一个项目使用的说明；
- 一条本可由脚本完成的固定命令；
- 为了绕过审批而隐藏动作。

## Community 插件生态的三层分工

社区市场不是第二套 Harness。它由注册表、发现体验和官方安装链组成：

```text
dsh-community/packages/marketplace/catalog.json
  catalog / testedDsh / verification
                │
                ▼
dsh-community/packages/marketplace
  browse / search / install UX
                │
                ▼
官方 dsh plugin add 安装链
```

| 组件 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| [`catalog.json`](https://github.com/kamanager2012/dsh-community/blob/main/packages/marketplace/catalog.json) | 插件元数据、版本、分类、验证线和兼容性注册 | 不替代 Plugin Manager，不直接成为 Runtime |
| [`dsh-community` marketplace](https://github.com/kamanager2012/dsh-community/tree/main/packages/marketplace) | 浏览、搜索、信息展示和安装入口 | 不重新实现 Agent loop，不替代官方安装协议 |
| `dsh-community` Desktop / TUI | 把目录和安装入口接入用户产品 | 不维护第二套插件安装真源 |

注册表和市场客户端的具体位置、与 Community Labs 的关系见[社区生态与产品入口](../00-overview/community-ecosystem.md)。

## Marketplace CLI 用法

真源在 [`dsh-community/packages/marketplace`](https://github.com/kamanager2012/dsh-community/tree/main/packages/marketplace)。从产品仓运行 `pnpm marketplace -- list`，二进制名仍是 `dsh-marketplace`。

```sh
dsh-marketplace list
dsh-marketplace search <keyword>
dsh-marketplace info <package-name>
dsh-marketplace install <package-name>[@version]
```

- `list`：列出注册表条目；
- `search`：按关键词筛选；
- `info`：查看包版本、兼容性、digest 和 provenance `[待复核]`；
- `install`：把用户选择交给官方 `dsh plugin add` 安装链，不另建安装器。

注册表是兼容性证据，不是安全保证。没有匹配验证线、只有 README 声明或 staging 未复核的条目，都应保留 `[待复核]`，不要写成无条件可用。

## 插件开发的风险

插件可以增加工具、读取 context、监听事件、启动进程或改变配置。开发时优先使用隔离 profile 和临时 workspace，不要在日常生产 DSH_HOME 里测试未审查插件。
