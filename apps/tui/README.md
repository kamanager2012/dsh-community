# `@dsh-community/tui`

社区终端入口。官方 `@deepseek-ai/dsh` 是 Runtime;终端界面是自研的
`@dsh-community/tui-surface`(`packages/tui`),跑在官方 host seam 上。

**不安装、不挂** `@deepseek-harness-tui/dsh-tui`。第三方 TUI 只许参考,不是产品;CI 有 `third-party-surface` 守卫强制。

架构:

```text
dsh-community (launcher)
      ↓
dsh --profile dsh-community-tui --patch <community overlay>
      ↓
官方 dsh-base + @dsh-community/tui-surface (自研 Ink UI)
      ↓
ctx.agents / session/event / userQuestions / approval (官方 seam)
      ↓
官方 Agent + 官方工具 + 官方审批
```

界面能力(自研):输入框、对话 transcript、思考折叠、工具卡片、审批/提问弹窗、状态栏;执行全部走官方。

```sh
dsh-community                 # 有对话就接着最近一条,否则开新
dsh-community new "任务"      # 新对话
dsh-community resume last     # 接着最近一条
dsh-community sessions        # 官方 session 列表
dsh-community doctor          # 自检(不打印密钥)
```

调试/脚本:`DSH_TUI_FIRST_PROMPT="任务"` 启动后直接发送一条消息(非交互场景)。

Session 仍在官方 `~/.dsh`。
