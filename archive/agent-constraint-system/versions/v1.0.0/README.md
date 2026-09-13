# Agent Constraint System (ACS)

> Deterministic Governance Layer for AI Coding Agents
> v1.0 — 2026-05-30

## 定位

ACS 是 AI Coding Agent 的执行边界系统。
Agent 不是代码所有者。Agent 是 proposal generator。
所有执行必须经过治理层。

## 架构

PROTECTED (最高) → SCOPE → WRITABLE → DENY (默认)

## 核心能力

- **执行边界 (C-1)**: 24 条危险 Bash 正则 + 8 条 ACS 自保正则
- **Violation 完整性 (C-2)**: 事件只追加，reset 必须 --force
- **完整性校验 (v1.0)**: 8 文件 SHA256 基线，status 自动检测篡改
- **零信任默认拒绝**: 无 scope = 所有写入被拦截

## 目录

- `hooks/` — Python 运行时引擎 (acs_lite.py, acs_task.sh)
- `src/` — TypeScript 提案/IR/风险引擎
- `aep/` — Agent Execution Protocol
- `tests/` — 测试
- `runtime/` — 运行时状态文件
