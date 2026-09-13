# Known Bugs — Current

## P0 (all fixed (formerly v5.1-v5.3, now v1.4.0), 2026-07-13)

1. **_is_acs_system_path 只保护 3 个路径** — ✅ v1.4.1 修复：保护整个 runtime/ 目录
   - Attack vector: agent 可 Write/Edit ACTIVE_TASK.json 改 allowed_dirs 禁用 ACS
2. **settings.json 等配置文件不受 Bash 保护** — ✅ v1.4.2 修复
3. **clear_violations 不清空 events** — ✅ v1.2.0 修复
4. **scope 双文件同步漂移** — ✅ v1.4.3 修复：_load_scope() 统一读 ACTIVE_TASK.json

## P1

5. **_self_protect_bash regex 过于激进** — 只读操作(cat/grep)也被拦截
6. **rm -rf 空目录触发 DANGEROUS_BASH** — find/mv 可绕过

## 变更历史
- 2026-07-13: v1.4.1-v1.4.3 (formerly v5.1-v5.3) — 完整 runtime/ 保护 + 配置文件保护 + scope 统一
- 2026-06-03: v1.2.0 (formerly v1.2.0) — 修复 clear_violations
