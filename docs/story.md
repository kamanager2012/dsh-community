# 对外叙事 · One Harness. Three Complementary Community Endpoints.

> 本文件是传播素材的事实版。所有数字与状态必须与仓库代码、Release、CI 一致;禁止使用 production-ready / complete / 100% compatible 一类未经证实的词。产品端定义以 [community-endpoints.md](community-endpoints.md) 为准。

## 一句话

**官方 DeepSeek Harness 是内核。我们走「官方互补版」路线：不重复建设官方已有端（Web、Windows Desktop、macOS Desktop 均由官方上游维护），只维护官方缺失的三个互补社区端：WSL/Linux 终端、Linux AppImage、Android（Remote Client）。前两个当前已发行；Android 活跃源码在本仓 `apps/android`，仍为 `[UNVERIFIED]`，在 Remote Acceptance 通过前不进入 Published Latest。**

## 三句话版本

1. 官方 DeepSeek Harness 是内核：Agent loop、Session persistence、Tool execution、官方 Web 与 Windows/macOS Desktop 都在官方上游。
2. 社区只做官方没有的互补端，当前发行两个入口：WSL/Linux 上的 `dsh-community` 终端与 Linux AppImage；Android（Labs / Remote Client）保持 `[UNVERIFIED]` 且不进入 Latest（历史版本 `v0.1.1-rc.2` 曾打包 Win/macOS，后续版本已退役并收敛为 Linux AppImage）。
3. 远程控制平面升级为 **Multi-Agent 统一安全控制面**（`packages/remote-adapter`）：基于 Noise IK 端到端加密、LAN/WebRTC/自建盲中继与幂等重放保护，同时纳管官方 DSH 与本机 **Claude Code / Codex CLI / OpenCode (ACP)**，并提供受限工作区 Git Diff 只读代码审阅（不依赖云端 SaaS，也不修改官方内核）。
4. 插件可以很多,但哪些真的能装、能跑、适配当前官方 pin、会申请什么权限,社区注册表逐个验证后告诉你。

## 与其它 Desktop 项目的差别(客观口径)

- 不 patch 官方上游表面(不打 patch-package 改 onboarding/preset/branding);上游升级 = 契约重验,不是重写 patch。
- Session 真源就是官方 `~/.dsh`,不另建 harness home。
- 生态定位是官方内核的**互补发行**：两个已发行互补端（WSL/Linux 终端 + Linux AppImage）是当前发行面；Android Remote Client 是未验证活跃源码端；Windows/macOS Desktop 与 Web 明确交还官方上游，不再双份构建。Registry = 验证层，Marketplace = 发现与安装 UX，Handbook = 文档。
- 不要说“我们另做了一套 Harness”，也不要再宣传自己替 Windows/macOS 打包桌面端。官方 Web 与 Win/macOS Desktop 归官方内核上游所有；社区只负责两个已发行互补端与实验中的 Android Remote 端。

## 当前事实(发布前必须复核)

- 代码版本与 Release 见 `package.json` 与 [Releases](https://github.com/kamanager2012/dsh-community/releases);Latest = releases/latest,Preview = 最新 pre-release。
- 平台打包状态以 [release workflow](https://github.com/kamanager2012/dsh-community/actions/workflows/release.yml) 最新一次 run 为准。
- 注册表收录数量以 [catalog.json](packages/marketplace/catalog.json) 为准。
- 不要把 Linux AppImage 写成 Linux 主产品端。Linux 主入口是终端。

## 禁止的表达

- "完整生态闭环"(拓扑完整 ≠ 生态完整)
- "最先进的 DSH Desktop"(不客观)
- "我们有 Web / Desktop / Terminal 三端"(Web 是官方的)
- 任何我们尚未在 CI 中证明的能力清单
