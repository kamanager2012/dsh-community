# BUG: .claude/audit/ 在 PROTECTED 且无豁免

- **严重度:** P0
- **模块:** acs_paths.py:87
- **发现:** 2026-06-03

## 现象

Write `.claude/audit/*` → `is_protected()` = True → +100 秒锁。

## 冲突

`CLAUDE.md` 明确 "Claude 可写入 .claude/audit/"，但 `acs_paths.py` 把它列入 `PROTECTED_PROJECT_RELATIVE`。

## 修复

`.claude/audit/` 从 PROTECTED_PROJECT_RELATIVE 移除，或 `check_write` 加 audit 豁免分支。
