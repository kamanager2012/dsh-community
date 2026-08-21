# Changelog

## Unreleased

## 0.1.0-rc.8-community.1 — Unreleased

- 版本身份契约：社区发行线镜像官方核心版本；当前未发布线为 `0.1.0-rc.8-community.1`，对应 `@deepseek-ai/dsh@0.1.0-rc.8`。Desktop 与 TUI 统一显示 Dual-Badge：`DeepSeek Harness Community v0.1.0-rc.8-community.1 [Official Core: @deepseek-ai/dsh@0.1.0-rc.8]`。已发布的 `v0.1.6` 保留为历史版本。

- 修复根目录 `pnpm start` / `tui` / `sessions` / `run doctor`：改走 `@dsh-community/tui`（`apps/tui`）入口，不再误调没有 `start` 的 `@dsh-community/tui-surface`。文档用 `pnpm run doctor`，避免撞上 pnpm 内置 `doctor`。

- 官方 Runtime pin：`@deepseek-ai/dsh` `0.1.0-rc.6` → `0.1.0-rc.8`（官方 GitHub 当前发行 / npm `next`）。npm `latest` 仍是 `0.1.0-rc.7`，本仓跟官方仓库当前表面，不跟 npm latest。
- Desktop / dsh-bridge spawn 增加 `--no-open`：rc.8 本地 `dsh web` 会自动开系统浏览器；Electron 壳只托管官方 UI，不再弹浏览器。
- 就绪解析忽略 `dsh web: opening the default browser...` 诊断行，只接受 loopback URL。
- 契约快照按 rc.8 重抽；`latest-tested` 改为 `0.1.0-rc.8`。
- 官方 rc.8 SQLite 存储格式不兼容：会话真源仍是官方 `~/.dsh`，社区层不迁移、不自造第二套 session。
- TUI 官方 peer（`dsh-llm` / `dsh-session` / `dsh-agent`）对齐同一 pin。
- Node 下限 `>=22.15.0`：官方 `dsh-session-persistence-jsonl` 使用 `node:zlib` zstd；22.14 上 `dsh web` 会在就绪前退出。

- 输入系统重写:移除 ink-text-input,自研按键处理(兼容 cooked/raw 模式整行输入)
- 修复:交互键入消息(含中文)未渲染——user/message 形状适配 + runtime-context 快照过滤
- 修复:draft 状态移入 store,消除 useInput 闭包状态丢失(修复 /help 与审批 y/n 失效)
- 审批弹窗真实端到端验证:官方沙箱升级 → 弹窗 → y 放行 → 工作区外文件写入成功

- 界面打磨：思考折叠(Tab 展开/收起)、/help 帮助面板、/exit 提示
- 文档对齐：apps/tui README 与 docs/tui-adapter.md 反映自研终端面架构(官方工具启用、0 禁用、KPI 表)

- TUI Ownership Closure 收尾：移除 preset-isolation 禁用层，官方工具(bash/fs 等)全部启用，执行与审批走官方瀑布；自研 UI 只做展示与交互
- 真实 key 端到端验证：对话流(助手/思考/回复)、工具调用(tool 卡片 + 文件真实落地)全部通过
- patch-surface KPI 更新：0 处工具禁用、6 处自有配置行、1 处自研 insert

- TUI Ownership Closure：终端自研 `@dsh-community/tui`（官方 seam：ctx.agents / session/event / userQuestions / approval），彻底移除第三方 TUI 挂载；第三方只许参考，CI 强制（third-party-surface 守卫）

## 0.1.6 — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.6

社区产品号统一为 **0.1.6**。根目录、Desktop、TUI 和 workspace 包同一数字。官方 Runtime 仍是 `@deepseek-ai/dsh@0.1.0-rc.6`，那是上游 pin，不是我们的版本。

- 官方 runtime 暂存**重写为纯 npm 经典 node_modules**：无符号链接、无虚拟店，Node 解压即可解析；安装时运行 postinstall，Linux 上 node-pty 原生编译，win/mac 用官方 prebuild
- 暂存自检：`@deepseek-ai/dsh-app-boot` / `commander` 必须能 require.resolve；node-pty 二进制必须存在；tar ≥ 80MB
- 本地全链路实测：首启解压 → 官方 Web 200 → 干净退出 → 二次启动不解压直接 200
- v0.1.3 / v0.1.4 桌面端不可用，保持 Pre-release；v0.1.5 tag 未发布，不要下载

## 0.1.4 — 2026-08-16
- 三个社区端：WSL/Linux Terminal、Windows Desktop、macOS Desktop

## 0.1.5 — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.5

tag 已打，GitHub Release 未发布。此 tag 仍用 v0.1.4 那套 pnpm 虚拟店暂存，不要当正式下载。

- 产品端钉死为三个社区端:WSL/Linux Terminal、Windows Desktop、macOS Desktop。官方 Web 是共享 `~/.dsh` 的官方入口,不是社区端。Linux AppImage 降为次要产物。
- `artifact-smoke` 按三个社区端验 Latest:Windows Setup / macOS dmg / Linux 终端(不是 AppImage)。Windows 静默安装后轮询 exe,不再默认 v0.1.2。
- 打包时官方 runtime tar 小于 80MB 会重打,避免复用残包。
- `pnpm start` / `doctor` / `tui` 会先编 workspace 依赖。干净 clone 后不再因为缺 `dsh-bridge` dist 而 tsc 失败。
- Electron-as-node 回退路径加 `--expose-internals`,避免官方 `cordis-plugin-hmr` 静默中止插件树。
- asar vendor=0 打包后护栏:发布流程打包后断言 asar 不含 `@deepseek-ai` / `node_modules`。

## 0.1.4 — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.4

Windows flatten 必须带上 `.pnpm`。v0.1.3 跳过它之后安装包又缩到 99MB，官方依赖可能不完整。本版解引用拷完整虚拟店，并校验 tar 至少 80MB。

## 0.1.3 — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.3

补丁版。`v0.1.2` 的 tag 曾被挪到只拷官方包本体的 Windows 暂存上，Latest 上的 Setup 一度变成缺依赖的 99MB 包。本版从完整 hoisted 树解引用压平再打包。

- Windows 暂存压平完整官方依赖树，不再只带 `@deepseek-ai/dsh` 本体
- 第一次启动先出加载页再解官方 Runtime；解压写 ready stamp，半截失败会重解
- 已发布 tag 禁止覆盖：publish job 发现 Release 已存在就失败
- 使用指南写明未签名 / SmartScreen / sha256 校验

## 0.1.2 — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.2

第一个三系统 Stable。官方 Runtime 的社区发行版：同一套 `~/.dsh`，Web / Desktop / Terminal 三个入口。v0.1.1 AppImage 里官方 `dsh web` 起不来，本版连同启动修复一起发布。

- Linux AppImage / macOS dmg / Windows NSIS（`DSH Community Setup 0.1.2.exe`），各带 sha256
- 官方 runtime 打成单个 `official-dsh.tar` 放进安装包，第一次启动解到 userData；Windows 不再拷 3 万个小文件
- 统一入口：`dsh-community` / `new` / `resume last` / `sessions` / `doctor` / `version` / `plugins` / `desktop`
- 没密钥打印 doctor 后退出，不闷头进 Ink
- 定位：One Harness. Three Surfaces. 不 patch 官方 UI，注册表是验证层不是目录
- Edition 已归档，下载只走本仓 Releases

Windows 安装包未签名；macOS dmg 未公证。portable zip 还没打。

## 0.1.2-preview — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.2-preview

稳定性修复版。v0.1.1 AppImage 里官方 `dsh web` 经 Electron-as-node 启动时不会绑定端口，桌面无法打开官方 UI；本版修复。

- 打包版优先用系统 Node 启动官方 `dsh web`，Electron-as-node 仅作回退
- 打包版主进程通过 `DSH_COMMUNITY_BIN` 定位暂存的官方包，启动失败不再静默
- 官方 Web 就绪后轮询端口（容忍 502 预热），避免 ERR_CONNECTION_REFUSED；页面加载竞态的 ERR_ABORTED 不再产生未处理 rejection
- 退出时终止插件安装子进程，不再遗留孤儿 pnpm 进程
- `dsh-community-tui --doctor`：自检官方包 / bin / 数据目录 / session 数 / TTY / API 密钥存在性，不启动对话、不打印密钥，密钥缺失时退出码 2
- Desktop 社区市场页支持一键安装 / 卸载：唤起官方 `dsh plugin --profile web add|remove`（不自造安装器），已装状态读官方 profile 的 package.json，完成后提示重启官方运行时生效

## 0.1.1 — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.1

0.1.1 = 0.1.1-preview 之上新增桌面内嵌市场页与壳打磨，注册表同时扩容。

- Desktop 社区市场页（托盘「社区市场」/ Host → Community marketplace）：只读浏览 [dsh-community-plugins](https://github.com/kamanager2012/dsh-community-plugins) 目录，10 分钟在线缓存，抓取失败回退 userData 缓存
- 安装仍走官方 `dsh plugin add <name>` 或 [dsh-marketplace](https://github.com/kamanager2012/dsh-marketplace) CLI；Desktop 不做第二套安装器
- 注册表收录 7 个社区验证插件（dsh-compressor / dsh-context / dsh-lan-access / dsh-memory-vault / dsh-plugin-hello / dsh-rtk-optimizer / dsh-voice），全部在 rc.6 上 `dsh plugin add` 安装 + 合成验证通过
- Desktop settings：hide-to-tray、可选隔离官方数据到 `userData/isolated-dsh`（改动重启 `dsh web`）
- 官方 session 列表显示 mtime，可复制 `dsh-community-tui --resume <id>`
- Host 诊断页；所有壳页面有统一的顶栏导航
- 隔离模式读/拉起 `userData/isolated-dsh`，不再指向 `~/.dsh`
- `dsh-community-tui` 把前置 `--` 当作 pnpm passthrough，`--help` / `--list-sessions` 可用
- 官方 `dsh web` 跑在子视图里，社区 chrome 条保持可见（Session / 设置 / 诊断随时可达）
- `--list-sessions` 在官方路径旁打印 transcript mtime

## 0.1.1-preview — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.1-preview

Published only from this repository. Official `@deepseek-ai/dsh@0.1.0-rc.6` is the development foundation.

- Community TUI launcher (`dsh-community-tui`) boots official `dsh --profile dsh-community-tui`
- `--list-sessions` / `--resume <id>` read and validate official `~/.dsh/sessions`
- `--resume` is forwarded as official app args (`dsh --profile … --resume <id>`)
- Desktop Host menu lists the same official session store
- TUI patch surface stays at 8 owned rows (reference TUI bundle is 33)
- Do not npm-publish workspace packages; do not use the `dsh-tui` binary name

## 0.1.0-preview — 2026-08-15

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.0-preview

First public-shaped preview. Not a replacement for official DSH, dsh-TUI, or the third-party Desktop installers.

- Thin Electron shell that spawns published `@deepseek-ai/dsh@0.1.0-rc.6` (`dsh web`)
- Official `~/.dsh` is the default session store
- Lifecycle-only IPC; stdout is diagnostics
- Contract snapshots of official CLI / config rows / session-agent-approval-plugin surfaces
- Desktop-owned Version Manager reads `latest-tested`; does not switch official artifacts yet
- TUI work is a seam + patch-surface KPI. Ink stays a mounted plugin, not a vendored fork
