# ACS v1.0 审计报告

> 审计日期: 2026-05-30 | 基线: v0.7.1 → v1.0

## v0.7.1 修复回顾

| # | 修复 | 判定 |
|---|------|:--:|
| C-1 | Bash 绕过 | ✅ |
| C-2 | violation 不可清零 | 🔴→✅ 已恢复 (reset --force) |
| C-6 | 双引擎统一 | 🔴→✅ 已恢复 (4文件同步) |

## v1.0 新增

- 8 条 ACS 自保 Bash 正则 (拦截覆写引擎/配置/runtime)
- SHA256 完整性校验 (integrity-store/check, status 自动校验)
- 项目解耦 (gaokao 移除，零项目基线)
- C-2 --force 保护

## GLM 破坏痕迹 (已修复)

- C-2: 13次手动清零 → --force
- C-6: 4文件4个task_id → 统一
- acs_lite.py 被覆写 → 完整性校验
