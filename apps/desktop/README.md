# `@dsh-community/desktop`

社区重构的桌面壳。对照的是「托盘保活官方 Host」这种产品能力，不是把官方 monorepo 或第三方 fork 贴进来。

```sh
pnpm --filter @dsh-community/desktop start
```

默认共用官方 `~/.dsh`。生命周期 IPC 只有重启 / 快照 / 诊断日志 / 打开官方 UI / 市场目录刷新。壳自己的设置、复制 `--resume`、页面切换走 `dsh:desktop:*`，不要在这里长 agent 协议。

Version Manager 在菜单 **Host → Runtime**。它读 `contracts/compatibility/latest-tested.json`，把兼容性推荐写进 Desktop `userData`；`latest-tested` 不等于 Candidate Source pin，也不等于 GitHub Published Latest。它不改官方 session 目录。

官方 Session 列表在 **Host → Official sessions** / 托盘「官方 Session」/ 壳顶栏 **Session**，只读当前官方 home 下的 `sessions/`。可复制 `dsh-community-tui --resume <id>`，不在 Desktop 里恢复对话。

**File → Desktop settings**：关窗藏托盘；可选隔离官方数据到 `userData/isolated-dsh`（改这项会重启 `dsh web`）。环境变量 `DSH_COMMUNITY_ISOLATED=1` 仍然强制隔离。

社区市场页在 **Host → Community marketplace** / 托盘「社区市场」：浏览本仓 [`packages/marketplace/catalog.json`](../../packages/marketplace/catalog.json)（在线抓取，10 分钟缓存到 userData，失败回退最近缓存）。已装状态读官方 `~/.dsh/profiles/web/package.json` 的 dependencies——不维护第二份安装记录。安装/卸载按钮唤起官方 `dsh plugin --profile web add|remove`（本窗口不自造安装器），完成后提示重启官方运行时生效；仓库链接走系统浏览器。

运行时行为：

1. 解析已发布的 `@deepseek-ai/dsh`（开发态用真正的 Node，不用 Electron 二进制去跑 CLI）。
2. `createOfficialHost` 拉起 `node <bin> web --host 127.0.0.1 --port 0 --no-open`（官方 0.1.0-rc.8 起本地会自动开系统浏览器；壳里不要再弹）。
3. 只接受 `dsh web: http://127.0.0.1:<port>`；忽略 `dsh web: opening the default browser...`。
4. 官方 UI 放在窗口下半的 `WebContentsView`；顶栏是社区壳，随时切 Session / 设置 / 诊断。
5. 其它 http(s) 走系统浏览器。官方视图不加载壳的 `data:` 文档。
6. 有托盘时关窗只是隐藏，Host 继续跑。托盘可显示窗口、重启官方运行时、退出。
7. 官方子进程异常退出时留在壳里，提供重启，而不是把 Electron 一起杀掉。

打包：

```sh
pnpm --filter @dsh-community/desktop package
./release/linux-unpacked/dsh-community
```

打包脚本在独立 `.pack-root` 里跑 electron-builder，避免 `pnpm install --production` 卸掉开发依赖。官方 runtime 打成单个 `official-dsh.tar`，第一次启动再解到 userData；不要把整个 pnpm `node_modules` 塞进 NSIS。解包目录是预览，未签名。
