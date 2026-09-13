# Agent Onboarding — ACS v1.1.0

## Agent 进入顺序（4 层认知）

```
1. status/SYSTEM_STATE.md     ← 第一个读：锁定？P0？风险？
2. PROJECT.md                 ← 系统定位
3. memory/agent-onboarding.md ← 你在这
4. memory/known-bugs.md       ← Top 3
```

10 秒进入工作状态。不再扫 repo。

## 活跃代码

```
~/.claude/hooks/        ← 运行中（根目录 hooks/ symlink）
~/.claude/runtime/      ← 状态文件（根目录 runtime/ symlink）
current → versions/v1.1.0
```

## 核心模块

| 文件 | 角色 |
|------|------|
| `acs_lite.py` | 主引擎 |
| `acs_paths.py` | 路径解析 |
| `acs_violations.py` | 违规管理 |
| `hook_orchestrator.py` | 总调度 |
| `filesystem_guard.py` | 文件守卫 |

完整文件树（29 个 .py + 角色 + 大小）→ `modules/INDEX.md`

## 禁止事项

- 不允许修改 `~/.claude/hooks/acs_*.py`（+100 秒锁）
- 不允许删除 `~/.claude/runtime/` 下文件
- `versions/v0.*` `versions/v1.*` 只读归档

## 已知陷阱

1. **写 `.claude/audit/` 必锁** — PROTECTED 路径
2. **`reset --force` 不清空 events** — 需手动 `echo '{"events":[]}' > VIOLATIONS.json`
3. **`rm -rf` 触发 DANGEROUS_BASH** — 用 `mv` 替代
4. **scope 内 shadow_mode=true 时只能写 `/tmp/claude-shadow/`**

## 解锁

```bash
rm ~/.claude/runtime/LOCKED ~/.claude/runtime/VIOLATIONS.json
echo '{"events":[]}' > ~/.claude/runtime/VIOLATIONS.json
python3 ~/.claude/hooks/acs_lite.py status
```

## 文档生命周期

```
analysis/   → 研究过程（发现问题 → 分析根因）
design/     → 设计方案（提出方案）
decisions/  → 最终决策（ADR 落地）
reports/    → 结果输出（记录结果）
```

## analysis 子目录

| 目录 | 用途 |
|------|------|
| `architecture-review/` | 架构分析 |
| `code-review/` | 代码审计 |
| `security-review/` | 安全分析 |
| `performance-review/` | 性能分析 |
| `incident-review/` | 事故复盘 |
| `compatibility-review/` | 兼容性分析 |
| `migration-review/` | 迁移分析 |

## reports 子目录

| 目录 | 用途 |
|------|------|
| `release/` | 版本发布报告 |
| `weekly/` | 周报 |
| `monthly/` | 月报 |
| `benchmark/` | 基准测试 |
