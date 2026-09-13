# ACS 路线图

## v1.2.0 — Recovery Loop
- 修复 `clear_violations`：`v["events"] = []` 替代负分抵消
- 修复 `.claude/audit/` 被 PROTECTED 与 CLAUDE.md 冲突
- 自动衰减恢复：window_score < threshold 时自动解锁

## v1.3.0 — 独立安装
- `ACS_ROOT` / `ACS_RUNTIME_DIR` / `ACS_AUDIT_DIR` 环境变量
- 安装脚本 `install.sh`：一键部署到任意目录
- 相对路径引用：不再硬编码 `~/.claude/`

## v1.4.0 — 策略引擎
- 可配置策略：不同项目不同阈值
- 多项目 scope 共享
- Agent 记忆集成（跨会话违规模式学习）

## v1.5.0 — 多 Agent 治理
- 子代理权限隔离
- 跨 Agent 违规追踪
- 治理面板（Web UI）
