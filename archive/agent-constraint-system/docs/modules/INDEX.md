# 运行时文件树 — ~/.claude/hooks/

## 核心引擎（4）

| 文件 | 大小 | 角色 |
|------|------|------|
| `acs_lite.py` | 30KB | 主引擎：check_write / check_bash / CLI |
| `acs_paths.py` | 10KB | 路径解析：PROTECTED / ZONE / CRITICAL_FILES |
| `acs_violations.py` | 14KB | 滑动窗口 + should_lock + integrity chain |
| `acs_structural.py` | 5KB | 结构完整性验证 |

## 编排层（2）

| 文件 | 大小 | 角色 |
|------|------|------|
| `hook_orchestrator.py` | 7KB | 多 hook 串行调度 → 聚合 deny |
| `orchestrator_config.json` | 0.8KB | 编排配置 |

## PreToolUse 守卫（9）

| 文件 | 大小 | 角色 |
|------|------|------|
| `filesystem_guard.py` | 9KB | 文件系统守卫（项目级保护） |
| `read_guard.py` | 3KB | secret 路径脱敏 |
| `sed_guard.py` | 1KB | sed -i 拦截 |
| `risk_engine.py` | 13KB | 风险评分（proposal 评估） |
| `proposal_guard.py` | 3KB | proposal 审批门 |
| `abi_guard.py` | 5KB | ABI 接口保护 |
| `stability_report.py` | 6KB | 稳定性报告 |
| `bash_guard.py` | 24B | 残疾占位 |
| `guard.py` | 2KB | 旧版通用 guard（未注册） |

## 治理层（5）

| 文件 | 大小 | 角色 |
|------|------|------|
| `shadow_workspace.py` | 16KB | create / diff / merge / reject |
| `authority_invariant.py` | 15KB | 语义完整性验证 |
| `export_graph.py` | 25KB | 依赖图导出 |
| `governance_sdk.py` | 8KB | 治理 SDK |
| `audit_hook.py` | 2KB | 审计 hook |

## 辅助模块（5）

| 文件 | 大小 | 角色 |
|------|------|------|
| `agent_memory.py` | 19KB | 子代理记忆管理 |
| `runtime_loop.py` | 14KB | 会话循环 |
| `prompt_compiler.py` | 14KB | 提示词编译 |
| `token_budget.py` | 5KB | token 预算 |
| `backup.sh` | 1KB | Shell 备份脚本 |

## 入口脚本（3）

| 文件 | 大小 | 角色 |
|------|------|------|
| `acs_task.sh` | 1KB | scope 初始化入口（用户命令） |
| `acs-task.sh` | symlink | → acs_task.sh |
| `block-edit.sh` | 110B | Shell Edit 拦截 |

## 其他（1）

| 文件 | 大小 | 角色 |
|------|------|------|
| `hooks.json` | 62KB | v3/v4 旧注册表（未清理） |

## 统计

- **活跃:** 25 / **闲置:** 2 (bash_guard, guard) / **过时:** 1 (hooks.json)
- **Python 总量:** ~256KB / **29 个 .py 文件**
