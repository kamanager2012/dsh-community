# 对外叙事 · One Harness. Three Surfaces.

> 本文件是传播素材的事实版。所有数字与状态必须与仓库代码、Release、CI 一致;禁止使用 production-ready / complete / 100% compatible 一类未经证实的词。

## 一句话

**我们没有再造 DeepSeek Harness。我们在官方 Harness 外面建立一个长期可维护的 Community Distribution:同一套 Runtime、同一套 Session、同一套插件,Web / Desktop / Terminal 三个入口。**

## 三句话版本

1. 官方 DeepSeek Harness 是发动机,社区层不重新实现 Agent loop、Session persistence、Tool execution。
2. 你在官方 Web 里开的对话,关掉 Web,用社区终端可以继续;再打开桌面壳,还是同一个会话 —— One Harness. Three Surfaces。
3. 插件可以很多,但哪些真的能装、能跑、适配 rc.6、会申请什么权限,社区注册表逐个验证后告诉你。

## 与其它 Desktop 项目的差别(客观口径)

- 不 patch 官方上游表面(不打 patch-package 改 onboarding/preset/branding);上游升级 = 契约重验,不是重写 patch。
- Session 真源就是官方 `~/.dsh`,不另建 harness home。
- 生态定位是 distribution,不是单个桌面壳:Desktop/TUI = surfaces,Registry = 验证层,Marketplace = 发现与安装 UX,Handbook = 文档。

## 当前事实(发布前必须复核)

- 代码版本与 Release 见 `package.json` 与 [Releases](https://github.com/kamanager2012/dsh-community/releases);Stable = releases/latest,Preview = 最新 pre-release。
- 平台打包状态以 [release workflow](https://github.com/kamanager2012/dsh-community/actions/workflows/release.yml) 最新一次 run 为准。
- 注册表收录数量以 [catalog.json](https://github.com/kamanager2012/dsh-community-plugins/blob/main/catalog.json) 为准。

## 禁止的表达

- "完整生态闭环"(拓扑完整 ≠ 生态完整)
- "最先进的 DSH Desktop"(不客观)
- 任何我们尚未在 CI 中证明的能力清单
