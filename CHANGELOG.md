# Changelog

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
