# ADR-002: Shadow Workspace 隔离写入

**日期:** 2026-05-29
**状态:** 已采纳

## 决策

所有对生产代码的修改先写入 `/tmp/claude-shadow/<task_id>/`，diff 通过后原子 merge。

## 原因

直接写入生产路径风险不可控。Shadow 提供：
- 隔离环境：写坏不影响生产
- diff 预览：合并前审查
- 原子合并：os.replace 保证一致性
- 审计日志：每次 merge 记录到 audit jsonl

## 流程

```
shadow create → Write in shadow → diff → merge → cleanup
```

## 后果

- scope 初始化时需指定 `--shadow` 标志
- 非 Shadow 路径写入被拦截（+40 分）
- 合并前必须 snapshot + diff
