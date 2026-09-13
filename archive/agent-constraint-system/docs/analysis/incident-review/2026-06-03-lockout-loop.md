# Incident: 2026-06-03 循环自锁

## 发生什么

3 次 Write `.claude/audit/gaokao-code-review-*.md` → 每次 +100 秒锁 → 用户 `reset --force` → 再写再锁 → 循环。

## 根因

两层 BUG 叠加：

1. **`acs_paths.py:87`** — `.claude/audit/` 在 PROTECTED_PROJECT_RELATIVE，但 CLAUDE.md 明确 "Claude 可写入 audit/"
2. **`acs_violations.py:160-169`** — `clear_violations` 只追加 `score=-old` 抵消而非 `v["events"] = []`，下次任意 +100 再次过线

## 影响

- 用户被迫手动 rm LOCKED + 清 VIOLATIONS.json 3 次
- 报告无法写入标准审计路径
- 暴露了 reset 机制的无效性

## 修复

- 短期：报告落到 `/tmp/` 再由用户 cp
- 长期：P0-1 修复 clear_violations；P0-2 澄清 audit/ 权限

## 防复发

- 任何新会话：先 `acs_lite.py status` 确认锁状态
- 写文件前确认目标路径不在 PROTECTED
- runbooks/LOCKED_SYSTEM.md 记录标准解锁流程
