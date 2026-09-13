# governor-core

**面向 AI 编码 Agent 的确定性、Agent 无关的策略与问责层。**

> **属于 [Agent Governance Stack](https://github.com/kamanager2012/agent-constraint-system) 的一部分** — 位于
> [ACS](https://github.com/kamanager2012/agent-constraint-system)（命令级执行闸门）与
> [aios-core](https://github.com/kamanager2012/aios-core)（计划级执行内核）之间的策略引擎层。

`governor-core` 在 AI Agent 的工具调用**执行之前**将其拦截，返回
**允许 / 拒绝 / 询问** 裁决，并将每一次决策记录到防篡改的哈希链审计日志中。被拒绝的动作不会发生，每一个动作都可追责。

当前多数 Agent 治理工具是观测性的——仪表盘和追踪告诉你 Agent *做了什么*。`governor-core` 决定 Agent *被允许做什么*，确定性、默认拒绝，发生在动作执行的那一刻。

> **它是什么 / 不是什么。** 这是**护栏与审计层**，不是**安全边界**。它对会犯错或漂移的**合作型** Agent 有效——幻觉出的 `rm -rf /`、写错路径、越界命令。它**不足以**对付**对抗性** Agent 或恶意代码：任何白名单上的通用解释器或构建工具（`node`、`python3`、`make`……）都能执行任意逻辑，而治理器运行在它试图约束的同一爆炸半径内。对不可信负载，必须搭配操作系统级沙箱。见
> [威胁模型与局限](#威胁模型与局限) 和 [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md)。

> 状态：`1.0.0`。命令层已加固，并由一个同时断言"拦截什么"和"不拦什么"的对抗测试套件覆盖。

---

## 为什么

- **确定性** — 决策路径上没有任何模型调用；同样的工具调用永远得到同样的裁决，行为可复现、可审计。
- **默认拒绝** — 无法分类的一律拒绝。审计写入失败，动作被拒绝。fail-open 的治理不是治理。
- **Agent 无关** — 核心只讲一个 `ToolCall → Verdict` 契约。适配器把宿主 Agent 的原生负载翻译成该契约。第一个适配器面向 **Claude Code `PreToolUse` hook**。
- **防篡改** — 审计日志是 SHA-256 哈希链；任何编辑、删除或重排都能被 `aigov log --verify` 检测。

## 安装

```bash
npm install
npm run build      # 编译 src → dist
npm test           # vitest
```

零运行时依赖（仅用 Node 标准库）。需要 Node.js >= 18。

## 在 Claude Code 中使用

构建项目后，在 `~/.claude/settings.json` 中注册 hook：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node /ABS/PATH/aigov/dist/adapters/claude-code/hook.js"
          }
        ]
      }
    ]
  }
}
```

现在，在真实会话中：

- `rm -rf /`、写入 `.env`、路径穿越写入会被**拒绝**。
- `git push`（及其他敏感操作）返回**询问**——由人类在带外授予一次性 token。
- `git status`、编辑 `src/*.ts` 等操作**允许**。

### 环境变量

| 变量 | 默认值 | 作用 |
|------|--------|------|
| `AIGOV_POLICY` | 内置 `DEFAULT_POLICY` | `policy.json` 路径 |
| `AIGOV_AUDIT` | `~/.aigov/audit.jsonl` | 哈希链审计日志路径 |
| `AIGOV_APPROVALS` | `~/.aigov/approvals` | 审批 token / 待决存储 |
| `AIGOV_ANCHOR` | `~/.aigov-anchors/audit.anchor` | 审计头的外部锚点（放在 Agent 够不到的地方） |

## 策略

`policy.json` 是内置默认策略的字段级覆盖：

```json
{
  "allowedPaths":    ["**/*"],
  "deniedPaths":     [".aigov/**", "**/.env", "**/secrets/**"],
  "allowedCommands": ["echo", "git", "node", "pnpm", "vitest", "tsc"],
  "deniedCommands":  ["rm -rf /", "rm", "sudo", "curl", "node -e", "..."]
}
```

- 路径 glob 匹配（不区分大小写）；绝对路径与 `../` 穿越直接拒绝。
- 命令按子命令匹配：行先按 shell 操作符和命令替换拆分，剥掉引号字面量，展开简单变量赋值——所以 `git; rm -rf /`、`echo $(rm -rf /)`、`X=rm; $X -rf /` 全都会被抓住，而 `echo "rm -rf /"`（字面量）不会。
- **拒绝优先。** 一条命令必须既不命中任何拒绝规则，*又*有白名单允许的命令头。

## CLI

```bash
aigov pending            # 列出等待审批的操作
aigov approve <id>       # 为单次操作授予一次性、TTL 限定的 token
aigov log                # 打印审计链
aigov log --verify       # 验证链完整性 + 交叉核对外部锚点
aigov anchor             # 将当前链头固定到锚点存储
```

## 执行模型

| 层 | 作用 |
|----|------|
| 范围 | 路径允许/拒绝 + 穿越防护；按子命令的命令允许/拒绝 |
| 反绕过 | 拆分链/替换、剥引号、展开 `VAR=` 间接引用 |
| 批量删除 | 语义检测（`find -delete`、`-exec rm`、`shred`、`rm -rf *`），独立于白名单 |
| 提权 | 通用执行器（`node`、`python3`、`make`、`npm`……）经 `elevatedCommands` 提级到 `ask` |
| 自保护 | 针对 governor-core 自身文件/状态的不可侵犯拒绝（任何 token 之前检查） |
| 审批 | 一次性 token，绑定确定性操作签名，带 TTL |
| 审计 | SHA-256 哈希链 JSONL；原子写入；损坏尾部 → fail-closed |
| 锚定 | 外部链头哈希锚点（`aigov anchor`），`--verify` 时交叉核对——检测整文件删除/重建 |
| 并发 | 原子 token 认领（`rename`）+ 串行化审计追加（`mkdir` 锁） |

## 威胁模型与局限

`governor-core` 提高**合作型** Agent 脱轨的成本，让每个动作都可追责。它**不是** OS 级沙箱，命令层是保守的模式匹配器，不是完整 shell 解析器。决定性的局限是结构性的：**它判断命令字符串，而 bash 在 syscall 层执行**——且白名单必然包含通用执行器。面对对抗性 Agent，请把命令层当作参考而非边界。

已知绕过类别（登记于 [docs/THREAT_MODEL.md](./docs/THREAT_MODEL.md)，并在 `tests/adversarial.test.ts` 中如实断言）：

- **解释器即任意执行。** 白名单上的解释器可以运行脚本**文件**（`node build.js`）或从 **stdin** 读代码（`echo '<code>' | python3`）；只有内联 `-e`/`-c` 求值被拒绝，这是部分覆盖，不是边界。随附策略把这些执行器提级到 `ask`（`elevatedCommands`，`ruleId: ask-elevated`），让人看到每一次——这是合作型 Agent 的闸门，不是对抗型 Agent 的墙。
- **构建工具运行任意生命周期脚本。** `npm run …`、`make`、`cargo`、`go run` 执行治理器从不检查的项目配置中定义的 shell；默认策略同样把它们提级到 `ask`。
- **自我禁用 / 审计抹除。** 经允许的解释器运行的代码可以改写宿主 hook 配置来卸载治理器，或截断审计日志；哈希链是防篡改*可检测*，不是*不可破坏*，需要外部锚点（见 `aigov anchor`）才能扛住整文件删除。
- **名称级路径检查。** 路径策略匹配字符串，不是解析后的 `realpath`；树内符号链接指向树外目标是一个 TOCTOU 缺口。
- shell 写入目标（重定向、`tee`、`sed -i`、`cp`/`mv`/`ln`/`install`、`dd of=`）*确实*受路径策略约束，所以逃逸出树的写入（`echo x > /etc/passwd`、`cp x ~/.ssh/...`）会被拒绝；树内写入被信任。
- Claude Code hook 有上游盲区：`PreToolUse` 不拦截 `Task` 子代理工具（[#26923]），且 `permissionDecision:"allow"` 一直不可靠（[#52822]）——执行依赖 `deny`/`ask`。

对不可信或恶意代码，请在 OS 级沙箱（容器、seccomp/eBPF、只读挂载、受限用户）内运行 Agent，**同时**配合
`governor-core`，此时它充当可审计的策略大脑。
见 [SECURITY.md](./SECURITY.md)。

[#26923]: https://github.com/anthropics/claude-code/issues/26923
[#52822]: https://github.com/anthropics/claude-code/issues/52822

## 开发

```bash
npm test           # 运行测试套件（scope、engine、hook、concurrency、adversarial）
npm run build      # 类型检查 + 生成 dist/
```

欢迎贡献 — 见 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全问题：
[SECURITY.md](./SECURITY.md)。

## 开源许可

[Apache-2.0](./LICENSE) © 2026 James Oldman.

---

[English](./README.md)
