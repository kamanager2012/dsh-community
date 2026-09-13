# ACS v1.6.1 架构

## Hook 管线

```
PreToolUse
  ├── settings.json (直接注册)
  │     ├── Write|Edit: acs_lite + guard + filesystem_guard + proposal_guard + authority_invariant + shadow_workspace + abi_guard
  │     ├── Bash:      acs_lite + bash_guard + sed_guard + filesystem_guard
  │     └── Read:      read_guard
  │
  └── settings.local.json (无 hooks，休眠)

PostToolUse
  └── settings.json
        ├── Write|Edit|Bash: audit_hook + token_budget
        └── Write:           risk_engine assess --stdin

Stop
  └── settings.json: acs_lite status + stability_report check
```

## 引擎架构

```
acs_lite.py (v1.6.1 主引擎)
  ├── 路径解析 + ZONE 分区
  ├── ACS_SELF_PROTECT: hooks/ + runtime/ + settings.json + CLAUDE.md + .claude.json
  ├── 滑动窗口违规追踪 (600s window, WINDOW_THRESHOLD=80, HARD_LOCK=150)
  ├── 完整性链 (sha256, 滚动哈希)
  ├── 基准命令白名单
  └── CLI: init / status / unlock / reset / integrity-store / integrity-check / chain-verify
```

## 运行时状态

```
~/.claude/runtime/  (全部受 ACS_SELF_PROTECT 保护)
  ├── ACTIVE_TASK.json    ← 当前 scope + task 配置 (v1.5.0: 权威源)
  ├── TASK_SCOPE.json     ← scope 兼容副本 (v1.5.0: 仅回退用)
  ├── VIOLATIONS.json     ← 违规事件数组 + window_score
  ├── INTEGRITY.json      ← 完整性链 (sha256 快照)
  ├── LOCKED              ← 锁文件 (存在 = 锁定)
  ├── MODE.json           ← ACTIVE / STRICT
  └── ACS_GUIDE.md        ← 操作指南

~/.claude/ 受保护配置文件 (v1.5.0):
  ├── settings.json       ← hook 注册 + 权限 (Write/Edit: ZONE=SYSTEM deny, Bash: ACS_SELF_PROTECT)
  ├── settings.local.json ← 本地覆盖
  ├── CLAUDE.md           ← 宪法文件
  └── .claude.json        ← 全局配置
```

## 数据流

```
Tool Call → PreToolUse hooks (串行)
              │
              ├── acs_lite.py:
              │     ├── 锁检查 → LOCKED? → deny (unlock 白名单除外)
              │     ├── ACS_SELF_PROTECT → hooks/ 或 runtime/ 或 settings.json 或 CLAUDE.md? → deny (100分 秒锁)
              │     ├── Scope 检查 → 在 scope 内? → allow
              │     └── Scope 外 → baseline_deny + add_violation(25)
              │
              └── 其他 guards → 各自检查 → allow/deny

Tool 执行

PostToolUse hooks (审计/日志)
  ├── audit_hook → 写入审计日志
  ├── token_budget → 更新 token 计数
  └── risk_engine → 风险评估 (仅 Write)
```

## ZONE 权限矩阵

| Zone | write | delete | mass_delete | overwrite |
|------|-------|--------|-------------|-----------|
| WORKSPACE | ✅ | ✅ | ✅ | ✅ |
| SOURCE | ✅ | ❌ | ❌ | ✅ |
| RUNTIME | ✅ | ❌ | ❌ | ❌ |
| SYSTEM | ❌ | ❌ | ❌ | ❌ |

## 违规评分

| 类别 | 分数 | 说明 |
|------|------|------|
| EXEC | 10 | 代码执行 — 4 次才锁 |
| WRITE | 25 | scope 外写入 — 3 次才锁 |
| DELETE | 60 | 删除文件 — 1 次近锁 |
| SYSTEM | 100 | 系统破坏 — 秒锁 |
| ACS_SELF | 100 | hooks/ 或 settings.json 修改 — 秒锁 |

**阈值**: window >= 80 锁定 | total >= 150 硬锁 | 衰减 600s

## 死锁防护

| 机制 | 说明 |
|------|------|
| unlock 白名单 | 锁死状态下也能执行 `acs_lite.py unlock` |
| 复合 Bash | `unlock && 操作 && reset && integrity-store` 一条命令完成所有修复 |
| ACS_GUIDE.md | 终端手动解封步骤，hook 崩溃时唯一出口 |
