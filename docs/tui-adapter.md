# 我们的 TUI

官方 DSH 是上游。参考仓 `dsh-TUI` 是第三方 Ink 实现，**不是**我们要提 PR 的上游。

我们的产品是 `@dsh-community/tui`（命令 `dsh-community-tui` / `pnpm tui`）：

- 运行时：官方 `dsh --profile dsh-community-tui`
- 组合：官方 `dsh-base` + 我们的薄 patch
- Ink：挂参考包 `@deepseek-harness-tui/dsh-tui` 当插件，**不**把它加成 `dsh.bundle`（否则会吃进它的 33 行 patch）

## 为什么比参考物薄

参考 `cordis.patch.yml` 有 33 行。其中 23 个 disable 是官方 web-app 已经在做的 preset 隔离，不是 TUI 能力。

我们拆成自己的两层：隔离 25 行 + TUI 自有 8 行。KPI 是**我们产品的 patch 面**，不是去改别人的仓库。

```
参考物 33
我们 TUI-owned 8（已过 15 档）
终态：只 insert 我们的 TUI 插件 + 工作状态行
```

Ink 屏幕仍来自参考实现，直到我们自己换渲染器。换渲染器也是我们仓里的事。

## 启动

```sh
pnpm tui
```

需要 TTY 和 `DEEPSEEK_API_KEY`。Session 在官方 `~/.dsh`。
