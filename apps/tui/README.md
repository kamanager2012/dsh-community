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
