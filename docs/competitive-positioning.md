# DSH Community：竞品与产品定位

> 资料核对：2026-11-17。比较依据以下项目的官方仓库与 README，**不是实机性能横评**；未列出的功能不表示竞品没有。

## 我们真正解决的问题

**多 Agent 同屏、E2EE、手机审批和 Git Diff 已是行业通用能力，不能作为独有卖点。** 本仓更明确的定位是：在 Linux / WSL2 上使用不魔改的官方 `@deepseek-ai/dsh` Runtime，提供 TUI、签名 AppImage、官方 `~/.dsh` 续跑、精确版本锁定和可核验发行证据。

| 首要任务 | 建议选择 | 第一手证据/边界 |
|---|---|---|
| 官方 DSH 运行时 + Linux 终端/桌面入口 | **[DSH Community](../README.md)** | [官方会话与发行事实](current-release.md)；不是唯一 Linux 客户端 |
| 终端持久运行、SSH、多 Agent panes | [Herdr](https://github.com/herdrdev/herdr) | 官方 README 说明持久终端、后台进程、状态识别 |
| 跨手机/桌面多 Agent 编排、加密与自托管 | [Happier](https://github.com/happier-dev/happier) | 官方 README：多 Agent、跨设备 E2EE |
| Worktree、编辑器、Diff、终端、PR 一体化 | [Paseo](https://github.com/getpaseo/paseo) | 官方 README：完整 Agent 开发环境 |
| Agent 会话到分支和 GitHub PR | [T3 Code](https://github.com/pingdotgg/t3code) | 官方主页与仓库：分支、审阅、PR 工作流 |
| DSH 原生插件式远程、P2P/TURN、更多 ACP | [DS Harness Remote](https://github.com/liguobao/ds-harness-remote) | 官方 README：原生 DSH 集成；托管与自托管 Web 功能边界不同 |
| Android 手机上本地运行 DSH | [dsh-Go](https://github.com/ccch1mneyyy/dsh-Go) | 其本地 Android Runtime 不同于我们的薄远程客户端 |
| 独立高功能 DSH TUI | [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) | 官方 README：第三方终端 UI |

## 可以承诺、不能承诺

- **可以承诺**：不 fork 官方 DSH Agent 执行内核，官方 DSH Session 保持在 `~/.dsh`；社区负责 Linux 发行与适配、TUI、签名 AppImage，远控作为可选能力。
- **必须区分**：Claude Code、Codex CLI、OpenCode 使用各自原生会话存储，只有 DSH 的会话真源是 `~/.dsh`；统一控制界面不是统一持久化。
- **发行口径**：GitHub Latest `v0.2.2-rc.3` 和社区 Pre-release `v0.2.2-rc.3-community.1` 是不同频道，以 [当前事实](current-release.md) 为准，不从源码版本猜测下载资产。
- **测试口径**：发布资产 smoke、Chromium + Mock Agent E2EE、真实 DSH Session 接续、Android x86_64 模拟器 R6、arm64 物理真机是五类不同证据，不能混为一谈。
- **限制**：Android 物理 `arm64-v8a` `[UNVERIFIED]`；暂无原生 iOS；真实外部 CLI/跨网络组合需更多用户验证；E2EE 不覆盖模型 Provider API 安全边界。
- **宣传禁语**：唯一/首创/最强多 Agent、所有平台 Production Ready、静态 Stars 排名、没有证据的竞品功能缺失、把模拟截图描述为真实外部 Agent 实机运行。

## 第一批用户验收计划（不是已完成指标）

| 试用场景 | 需要的去敏证据 | 问题分类 |
|---|---|---|
| 干净 Ubuntu / WSL2 安装 | OS 与 Node/pnpm 版本、安装方式、退出码 | 前置依赖 / PATH / 构建 |
| 新建 DSH Session，退出再恢复 | 官方核版本、执行步骤、是否恢复，勿公开真实对话 | 官方接口 / 进程 / Session |
| AppImage 完整性验证及启动 | Tag、校验结果、桌面环境、脱敏日志 | Release / 解压 / 离线缓存 |
| 手机远程配对与工具审批 | 客户端 OS、LAN 或 HTTPS/WSS、实际已授予能力及结果 | 网络 / 配对 / 权限 / 幂等 |
| 是否比现有工具更适合 | 自愿描述工作流、阻碍、原本使用的替代产品 | 产品定位 / 首次体验 |

收集用户**自愿且去敏**的 [首次试用反馈](https://github.com/kamanager2012/dsh-community/issues/new?template=first-run-feedback.yml)，不要求默认遥测，不上传源码、密钥或完整会话。

## 对外一句话

> DSH Community 补齐官方 DeepSeek Harness 在 Linux / WSL2 上的 TUI 与签名桌面发行体验，并保留官方内核和 DSH 会话真源；E2EE 多 Agent 远控是可选扩展。

[English version](competitive-positioning.en.md)
