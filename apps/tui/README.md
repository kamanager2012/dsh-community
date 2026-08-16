# `@dsh-community/tui`

我们自己的第三方 TUI，不是给参考仓提补丁。

- **上游**：官方 `@deepseek-ai/dsh`
- **参考**：`@deepseek-harness-tui/dsh-tui` 的 Ink 实现（我们挂它，不吃它的 33 行 bundle patch）
- **我们**：profile `dsh-community-tui` + 更薄的 composition

```sh
pnpm tui
# 或构建后
dsh-community-tui
```

需要 TTY 和 `DEEPSEEK_API_KEY`。Session 仍在官方 `~/.dsh`，和 Desktop / 官方 Web 同一真源。

```sh
dsh-community-tui --help
dsh-community-tui --list-sessions
dsh-community-tui --resume <official-session-id>
dsh-community-tui --doctor
```

`--doctor` 是自检：报告官方包 / bin / 数据目录 / session 数 / TTY / API 密钥是否存在，不启动对话、不打印密钥；密钥缺失时以退出码 2 结束。

`--resume` 会校验官方 `~/.dsh/sessions`，再交给官方启动器：

`dsh --profile dsh-community-tui --patch <community.patch> --resume <id>`

这是官方 CLI 文档里的透传方式，不是 `~/.dsh-cc` 第二套 store。
