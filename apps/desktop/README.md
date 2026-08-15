# `@dsh-community/desktop`

社区重构的桌面壳。对照的是「托盘保活官方 Host」这种产品能力，不是把官方 monorepo 或第三方 fork 贴进来。

```sh
pnpm --filter @dsh-community/desktop start
```

默认共用官方 `~/.dsh`。IPC 只有生命周期（重启 / 快照 / 诊断日志）。不要在这里长业务协议。

Version Manager 在菜单 **Host → Runtime**。它读 `contracts/compatibility/latest-tested.json`，把 pin 写进 Desktop `userData`，不改官方 session 目录。

运行时行为：

1. 解析已发布的 `@deepseek-ai/dsh`（开发态用真正的 Node，不用 Electron 二进制去跑 CLI）。
2. `createOfficialHost` 拉起 `node <bin> web --host 127.0.0.1 --port 0`。
3. 只接受 `dsh web: http://127.0.0.1:<port>`。
4. 窗口加载该 origin；其它 http(s) 走系统浏览器。
5. 有托盘时关窗只是隐藏，Host 继续跑。托盘可显示窗口、重启官方运行时、退出。
6. 官方子进程异常退出时留在壳里，提供重启，而不是把 Electron 一起杀掉。

打包：

```sh
pnpm --filter @dsh-community/desktop package
./release/linux-unpacked/dsh-community
```

打包脚本在独立 `.pack-root` 里跑 electron-builder，避免 `pnpm install --production` 卸掉开发依赖。`stage-official-runtime.mjs` 用 `pnpm deploy --prod` 暂存**已发布**的官方包。解包目录是预览，未签名。
