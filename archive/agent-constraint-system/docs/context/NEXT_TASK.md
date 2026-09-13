# 下一步 — ACS v1.2.0+

## 已完成 (2026-06-05)

1. ✅ **P0-1**: proposal_guard 从 PreToolUse 移至 PostToolUse
2. ✅ **P0-1b**: acs_lite 加 `_infer_from_path` fallback
3. ✅ **P0-2**: `clear_violations` 真重置（events=[] + genesis baseline）
4. ✅ **P0-3**: 白名单 open-world + `is_relative_to` 防遍历
5. ✅ **P1-4**: audit/ 从 PROTECTED 移至 RUNTIME zone
6. ✅ **P2-6**: rm -rf 正则收窄
7. ✅ **P2-7**: read_guard settings.json 研发模式
8. ✅ **基础设施**: 版本号同步、DEFAULT_CONFIG 同步、python3 -c 降级

## 待做 — P2 改进

1. **版本升级脚本** — `upgrade.sh` 自动创建新版本目录 + 切 symlink
2. **代码正式迁入版本目录** — `~/.claude/hooks/` → `v1.2.0/hooks/`
3. **孤儿 hook 清理** — 22 个 .py 中许多未注册到 orchestrator，增加认知负担
4. **hooks.json 62KB 遗留清理** — 与 orchestrator_config.json 功能重叠
5. **bash_guard.py 24字节空壳** — 移除或合并到 guard.py

## 待做 — 架构改进

6. **独立安装** — 支持 `ACS_ROOT` / `ACS_RUNTIME_DIR` / `ACS_AUDIT_DIR` 环境变量
7. **高考项目 Knowledge Center** — 结构迁移到 `~/my-project/projects/gaokao/`
8. **integrity chain 自动重建** — 检测到 TAMPERED 但 score=0 时自动 rebuild