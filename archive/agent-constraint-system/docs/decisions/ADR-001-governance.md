# ADR-001: Agent 不信任原则

**日期:** 2026-05-28
**状态:** 已采纳（不可逆）

## 决策

不信任 AI Agent 的任何 Write / Edit / Bash 操作。所有 mutating 调用必须经过治理层拦截。

## 原因

AI Agent 会漂移、幻觉、绕过 scope、修改不相关文件、虚假报告完成。在高考项目 90K 行代码库中，一次误写可能导致生产数据损坏。

## 后果

- 所有 Write/Edit/Bash 经过 PreToolUse hook
- 增加了 hook 链开销（每次 ~40ms）
- 新 Agent 会话必须初始化 scope

## 替代方案

- 事后审计（被拒：修复成本 > 预防成本）
- 仅 CI 检查（被拒：太慢，Agent 可绕过）
