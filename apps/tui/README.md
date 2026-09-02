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
ctx.agents / ctx.attachments / session/event / userQuestions / approval (官方 seam)
      ↓
官方 Agent + 官方工具 + 官方附件存储 + 官方审批
```

界面能力(自研):输入框、对话 transcript、图片输入、思考折叠、工具卡片、审批/提问弹窗、状态栏;执行全部走官方。

按键:

```text
回车     发送
Esc      打断当前回答
Tab      展开/收起思考
y / n    审批弹窗:允许一次 / 拒绝
数字键   提问弹窗:选择选项
/help    显示按键帮助; /exit 退出
```

## 图片输入（rc.2）

```text
/image "截图.png" -- 分析这个错误
/image "第一张.jpg" "第二张.webp" -- 比较两张图
/image "只有图片.png"
```

路径支持引号，因此文件名可以包含空格。当前接受的格式跟随官方 attachment
运行时策略；rc.2 默认能力覆盖 PNG/JPEG/WebP/GIF。

TUI 只负责读取用户明确指定的本地文件。图片随后交给官方
`ctx.attachments.saveImages()` 完成批量限制、解码校验、规范化和持久化；
session message 只写官方返回的 `ImageAttachmentRef`，不会把本地路径或
base64 写入会话日志。恢复历史会话时继续读取同一个 durable reference。

输入系统自研(不依赖 ink-text-input):官方 CLI 先占用 raw 模式,终端输入常以
cooked 整行(`"y\r"` 这种)送达——按键层按字符规范化,raw/cooked 两种模式都兼容。

```sh
dsh-community                 # 有对话就接着最近一条,否则开新
dsh-community new "任务"      # 新对话；任务正文不会进入子进程 argv
dsh-community resume last     # 接着最近一条
dsh-community sessions        # 官方 session 列表
dsh-community doctor          # 自检(不打印密钥)
```

调试/脚本:

```text
DSH_TUI_FIRST_PROMPT="任务"   启动后直接发送一条消息(非交互场景)
DSH_TUI_DEBUG=1               事件流/按键调试输出(stderr)
```

`DSH_TUI_FIRST_PROMPT` 也接受同样的 `/image ...` 语法。Launcher 用它把
`new "任务"` / 简写任务从 child argv 中移出；TUI 读取后会立即删除该环境项，
再通过官方 `agent.followup` seam 提交。它只是短生命周期进程传输，不是秘密存储；
不要把长期凭据写进 Prompt。

Session 仍在官方 `~/.dsh`。
