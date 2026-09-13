# 安装与首次启动

## 你要安装的是什么

dsh 有两种常见使用方式：

1. 通过 npm 临时运行已发布的 CLI；
2. 克隆官方仓库，从源码安装并运行。

普通使用优先选择 npm。需要阅读源码、开发插件或固定整个仓库构建链时，才选择源码方式。

## 运行时前置条件

Web UI 和 CLI 需要 Node.js。上游开发指南当前要求 Node.js 22.19+ 或 24+；版本升级后仍应以仓库的 engines、开发指南和命令帮助为准。

先检查：

~~~bash
node --version
npm --version
~~~

如果你要从源码构建，还需要 Git 和 pnpm。官方仓库在 package.json 中固定 pnpm 版本，建议通过 Corepack 管理，不要在一个工作区混用多个 pnpm 主版本：

~~~bash
corepack enable
pnpm --version
git --version
~~~

Python SDK 另有 Python 3.10+、Git、平台和隔离 workspace 要求，详见[Python SDK](../automation/python-sdk.md)。

## 最短启动路径

~~~bash
npx @deepseek-ai/dsh web
~~~

默认绑定本机地址：

~~~text
http://127.0.0.1:3080
~~~

启动后打开终端打印的地址。第一次不要把监听地址改成公网网卡，也不要把包含秘密的生产目录直接选为 workspace。

## Community 发行版入口

普通用户的社区发行版入口是 [`dsh-community`](https://github.com/kamanager2012/dsh-community/releases/latest)，不是 Suite、Edition、Marketplace 或 Plugins。

- 已发布可下载版本：`v0.1.1-rc.1`；精确资产、sha256 和门禁见[当前 Community 发行状态](../11-operations/community-release-status.md)。
- 官方内核：`@deepseek-ai/dsh@0.1.1-rc.1`，与产品号 1:1 同号。
- 历史独立编号 `v0.1.2`–`v0.1.6` 不是下载入口。
- Desktop 与 TUI 的身份应显示为：`DeepSeek Harness Community v0.1.1-rc.1 [Official Core: @deepseek-ai/dsh@0.1.1-rc.1]`。

## 固定版本

开发预览版本可能发生破坏性变化。短期尝试可以使用未锁定命令；团队或 CI 应显式固定版本：

~~~bash
npx --yes @deepseek-ai/dsh@VERSION web
~~~

把 VERSION 替换成团队批准的版本号，并在升级时同时记录 Node 版本、Provider、模型和 profile。不要因为 npx 能下载就认为版本兼容已经证明。

## 安装后的第一轮检查

启动后按此顺序进行：

1. 确认 Web UI 能打开；
2. 进入 Settings → Models 配置 Provider；
3. 选择一个没有重要未提交改动的 workspace；
4. 发送只读任务；
5. 用 git status、git diff --stat 和项目自己的测试命令检查结果；
6. 再决定是否允许写入。

## 常见安装失败

| 症状 | 先检查 |
| --- | --- |
| Node 版本不满足 | node --version、上游 engines 和 PATH |
| npx 下载失败 | npm registry、代理、证书、缓存和网络策略 |
| 命令不存在 | npx 实际解析的包、当前 shell 和 PATH |
| Web 端口占用 | 使用其他端口并确认只绑定本机 |
| 源码 pnpm install 失败 | Corepack、pnpm 版本、锁文件和 Git |
| Python SDK 安装失败 | Python、平台、虚拟环境和包索引 |
| 页面能开但不能输入 | 先在 UI 中添加并选中 workspace |
| 能输入但请求失败 | Provider、凭据引用、模型 ID 和网络边界 |

错误信息要保留脱敏版本。不要把整个 shell 环境或凭据文件上传给别人排查。
