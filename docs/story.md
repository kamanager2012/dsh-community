# 对外叙事 · One Harness. Five Community Endpoints.

> 本文件是传播素材的事实版。所有数字与状态必须与仓库代码、Release、CI 一致;禁止使用 production-ready / complete / 100% compatible 一类未经证实的词。产品端定义以 [community-endpoints.md](community-endpoints.md) 为准。

## 一句话

**官方 DeepSeek Harness 是内核。我们基于官方内核发行：一套 Runtime，五个入口（WSL/Linux 终端、Windows 桌面、macOS 桌面、Linux AppImage、Android），和官方 Web 共用同一套 `~/.dsh`。**

## 三句话版本

1. 官方 DeepSeek Harness 是内核：Agent loop、Session persistence、Tool execution、官方 UI 都在官方。
2. 社区基于官方内核，发行五个入口：WSL/Linux 上的 `dsh-community`、Windows Setup.exe、macOS dmg、Linux AppImage、Android（Labs）。官方 Web 是内核自带界面，不是我们的端。
3. 插件可以很多,但哪些真的能装、能跑、适配当前官方 pin、会申请什么权限,社区注册表逐个验证后告诉你。

## 与其它 Desktop 项目的差别(客观口径)

- 不 patch 官方上游表面(不打 patch-package 改 onboarding/preset/branding);上游升级 = 契约重验,不是重写 patch。
- Session 真源就是官方 `~/.dsh`,不另建 harness home。
- 生态定位是基于官方内核的社区发行:五个入口是发行面,Registry = 验证层,Marketplace = 发现与安装 UX,Handbook = 文档。
- 不要说“我们另做了一套 Harness”。官方 Web 是内核自带界面；五个社区端是基于官方内核的入口。

## 当前事实(发布前必须复核)

- 代码版本与 Release 见 `package.json` 与 [Releases](https://github.com/kamanager2012/dsh-community/releases);Latest = releases/latest,Preview = 最新 pre-release。
- 平台打包状态以 [release workflow](https://github.com/kamanager2012/dsh-community/actions/workflows/release.yml) 最新一次 run 为准。
- 注册表收录数量以 [catalog.json](https://github.com/kamanager2012/dsh-community-plugins/blob/main/catalog.json) 为准。
- 不要把 Linux AppImage 写成 Linux 主产品端。Linux 主入口是终端。

## 禁止的表达

- "完整生态闭环"(拓扑完整 ≠ 生态完整)
- "最先进的 DSH Desktop"(不客观)
- "我们有 Web / Desktop / Terminal 三端"(Web 是官方的)
- 任何我们尚未在 CI 中证明的能力清单
