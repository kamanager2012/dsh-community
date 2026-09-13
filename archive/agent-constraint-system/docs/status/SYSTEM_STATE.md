# SYSTEM STATE

## 运行状态

- ACS: **ACTIVE** (v1.1.0, unlocked)
- Window score: 0/80
- 最近锁定: 2026-06-03 · Write `.claude/audit/` → +100 → locked · loop ×3

## P0 问题（必读）

1. **clear_violations 不清空 events** — `reset --force` 用负分抵消，下次 +100 又锁
   → `reports/bug/2026-06-03-clear-violations-not-real-clear.md`
2. **`.claude/audit/` 被 PROTECTED** — 写 audit 必锁
   → `reports/bug/2026-06-03-audit-protected-conflict.md`

## 风险模块

- `acs_violations` — clear_violations 逻辑缺陷
- `acs_paths` — PROTECTED 与 CLAUDE.md 冲突

## 已知降级项

- `rm -rf` 空目录也触发 DANGEROUS_BASH — 用 `mv` 替代
- scope 内 shadow_mode=true 只能写 `/tmp/claude-shadow/`

## 快捷入口

| 需要 | 路径 |
|------|------|
| 解锁 | `runbooks/lock-recovery.md` |
| 所有 bug | `reports/bug/` |
| 模块债务 | `modules/*/known-issues.md` |
| 下一步 | `context/NEXT_TASK.md` |
| 路线图 | `context/ROADMAP.md` |
