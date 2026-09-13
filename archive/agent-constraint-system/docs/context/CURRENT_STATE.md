# 当前状态 — ACS v1.2.0

## 运行态

| 项目 | 状态 |
|------|------|
| 活跃代码 | `~/.claude/hooks/` (v1.2.0) |
| 运行时状态 | `~/.claude/runtime/` |
| 项目文档 | `~/agent-constraint-system/` |
| 版本管理 | `current → v1.2.0` |
| Integrity Chain | hash verified, genesis clean |

## 已部署

- hook_orchestrator 统一调度（v1.2.0, DEFAULT_CONFIG 同步）
- 滑动窗口锁（WINDOW_SIZE=10, THRESHOLD=80）
- ZONE 分区权限（WORKSPACE/SOURCE/RUNTIME/SYSTEM，audit/ 改为 RUNTIME）
- Shadow Workspace（create/diff/merge/cleanup）
- 完整性链（rolling hash chain, genesis baseline）
- SCOPE_BASELINE（38 个只读命令无 scope 仍可用）

## v1.2.0 控制流重构 (2026-06-05)

| # | 修复 | 文件 |
|---|------|------|
| P0-1 | proposal_guard → PostToolUse | orchestrator_config.json, hook_orchestrator.py |
| P0-1b | _infer_from_path fallback | acs_lite.py |
| P0-2 | clear_violations 真重置 | acs_violations.py |
| P0-3 | open-world 白名单 + is_relative_to | proposal_guard.py |
| Safety | 3 行 assert | acs_lite.py |
| P1-4 | audit/ → RUNTIME zone | acs_paths.py |
| P2-6 | rm -rf 正则收窄 | guard.py |
| P2-7 | settings.json 研发模式 | read_guard.py |
| #1 | DEFAULT_CONFIG 同步 v1.2.0 | hook_orchestrator.py |
| #2 | acs_lite 版本号 v1.2.0 | acs_lite.py |
| #3 | python3 -c 研发模式降级 | acs_lite.py |

## 已知残余问题

1. **孤儿 hook 文件** — 22 个 .py 中许多未注册到 orchestrator
2. **hooks.json 62KB 遗留** — 与 orchestrator_config.json 功能重叠
3. **bash_guard.py 24字节空壳** — 可合并到 guard.py
4. **无独立安装脚本** — 依赖 `~/.claude/` 目录结构

## 运行中的 scope

```bash
python3 ~/.claude/hooks/acs_lite.py status
```