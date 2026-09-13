# 当前会话 (2026-05-30) — ACS v0.3.x 系统基线

## 状态：MAINTENANCE

### 任务
- **任务ID**: acs-cleanup-2026-05-30
- **目标**: ACS 系统清理，移除 gaokao 项目绑定，恢复 C-2 violation 完整性
- **结果**: 完成。ACS 恢复为零项目干净状态，等待新项目接入。

### ACS
- engine: acs_lite.py v0.3.x
- task: (none) — auto-init mode
- scope: empty (所有 agent 写入被拦截，等待项目初始化)
- violations: 0/100
- C-2: ENFORCED (reset requires --force)

### 接入新项目
```bash
.claude/hooks/acs-task.sh <project-name> "<dir1>,<dir2>,..."
```
