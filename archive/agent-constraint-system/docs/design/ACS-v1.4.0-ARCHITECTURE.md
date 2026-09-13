# ACS v1.4.0 — Agent Constraint System Architecture

> 2026-06-06 | 单文件自包含 | 止血层 + Token Budget + Context Pruner 一体化

## 架构总览

```
Claude Desktop
  │
  ├─ settings.json
  │   ├─ permissions.allow: Read(*) only
  │   └─ CLAUDE_CODE_EFFORT_LEVEL: balanced
  │
  ├─ PreToolUse hooks:
  │   ├─ acs_lite.py          ← 唯一决策中心 (v1.4.0)
  │   │   ├─ scope check       — 目录白名单
  │   │   ├─ bash guard        — 28 种危险模式 (行为语义分类)
  │   │   ├─ proposal gate     — /proposal 审批流程
  │   │   ├─ token budget      — 120k/200k 阈值 + 自动模型降级
  │   │   ├─ context prune     — 25 轮 /compact 提醒
  │   │   └─ structural        — JSON/TS 完整性校验
  │   ├─ filesystem_guard.py   — 文件系统路径保护
  │   ├─ proposal_guard.py     — 纯审计 (PostToolUse)
  │   ├─ shadow_workspace.py   — Shadow Workspace 隔离
  │   ├─ abi_guard.py          — ABI 保护
  │   └─ bash_guard.py         — Bash 命令守卫
  │
  ├─ PostToolUse hooks:
  │   ├─ audit_hook.py         — 审计日志
  │   └─ risk_engine.py        — 风险评估
  │
  └─ Stop hooks:
      ├─ acs_lite.py status    — 会话结束状态检查
      └─ stability_report.py   — 稳定性报告
```

## 决策流

```
PreToolUse 事件
    │
    ▼
acs_lite.py (唯一决策中心)
    │
    ├─ 1. PROTECTED     → 始终 DENY (系统路径/acs/hooks 自身)
    ├─ 2. ALWAYS_WRITE  → ALLOW (runtime/audit/tmp)
    ├─ 3. ZONE CHECK    → SYSTEM→DENY, RUNTIME→append-only
    ├─ 4. SCOPE CHECK   → 无 scope → baseline 只读
    ├─ 5. SHADOW WALL   → shadow mode → 仅 /tmp/claude-shadow
    ├─ 6. PROPOSAL GATE → 路径推断 + proposal 验证
    ├─ 7. SCOPE RANGE   → in_scope → ALLOW, else DENY
    └─ 8. STRUCTURAL    → 文件缩水/大小检查
```

## Proposal 模式

`--proposal` 启用后，scope 外路径写入需先 `/proposal`。30 分钟内审批有效。

## Token Budget

| 参数 | 值 | 说明 |
|------|---|------|
| TOKEN_SOFT_LIMIT | 120,000 | 触发压缩 |
| TOKEN_HARD_LIMIT | 200,000 | 强制新会话 |
| COMPACT_INTERVAL | 25 | /compact 提醒 |

降级链: `sonnet-4 → haiku-3.5 → deepseek-v3 → glm-4-flash → minimax-ab01`

## 危险 Bash 分类

| 类别 | 分值 | 说明 |
|------|------|------|
| EXEC | 10 | 内联解释器 (研发模式警告) |
| WRITE | 25 | 文件修改 |
| DELETE | 60 | 文件删除 |
| SYSTEM | 100 | mkfs/reboot/shutdown |
| NETWORK | 60 | git force push |
| ACS_SELF | 100 | ACS 引擎篡改 |

研发模式 (`ACTIVE`/`RESEARCH`) 下 inline/heredoc interpreter 只警告不拦截。

## CLI

```bash
acs_lite.py init <task_id> <dirs> [--shadow] [--proposal]
acs_lite.py status
acs_lite.py reset --force
acs_lite.py unlock
acs_lite.py budget-report
acs_lite.py compact-ack
acs_lite.py integrity-check | integrity-store | chain-stats | chain-verify
```

## 解锁

```bash
rm ~/.claude/runtime/LOCKED ~/.claude/runtime/VIOLATIONS.json
echo '{"events":[]}' > ~/.claude/runtime/VIOLATIONS.json
```
