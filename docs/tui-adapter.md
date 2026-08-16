# 社区终端

官方 DSH 是上游和运行时。

第三方 `dsh-TUI` / `@deepseek-harness-tui/dsh-tui` **只许参考，不许挂进产品**。

终端实际启动：

```sh
dsh --profile dsh-community-tui --patch <community overlay>
```

社区层只做入口：`new` / `resume` / `sessions` / `doctor`。不重写 Agent loop，不另建 session 目录。
