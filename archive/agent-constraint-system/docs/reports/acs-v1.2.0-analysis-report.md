# ACS v1.2.0 系统完整分析报告

**日期**: 2026-06-05 | **版本**: v1.2.0 | **状态**: 生产就绪

---

## 1. 系统概述

ACS (Agent Constraint System) 是零信任 AI 工程运行时治理层。假设 AI agent 可能 drift、幻觉、绕过 scope 或虚假报告完成，所有 Write/Edit/Bash 必须经过治理层。

### 架构图

```
Claude Code 请求
  → hook_orchestrator.py (v1.2.0 统一调度)
    PreToolUse:
      Write|Edit → acs_lite.py → filesystem_guard.py
      Bash      → acs_lite.py → sed_guard.py → filesystem_guard.py
      Read      → read_guard.py
    PostToolUse:
      Write|Edit|Bash → abi_guard → audit_hook → token_budget → risk_engine
      Write|Edit      → proposal_guard.py (纯审计)
      Read            → agent_memory.py
    Stop:
      acs_lite status → stability_report → runtime_loop
```

### 控制流设计原则

| 原则 | v1.1.0 | v1.2.0 |
|------|------|------|
| 决策中心 | proposal_guard + acs_lite 双门 | **acs_lite 唯一决策中心** |
| PreToolUse 语义 | proposal_guard 做 PostToolUse 的事 | 无状态过滤 |
| PostToolUse 语义 | — | 纯审计 (只记录不拦截) |
| reset 语义 | 追加负分 (半重置) | events=[] + genesis baseline |

---

## 2. 文件清单

### 2.1 活跃 Hook (17个)

| 文件 | 行数 | 职责 | 管线 |
|------|------|------|------|
| `acs_lite.py` | ~700 | 核心决策引擎: scope/zones/proposal/structural 统一出口 | Pre W/E/B + Stop |
| `acs_paths.py` | ~260 | 路径解析: zones/protected/writable/shadow/scope 判定 | 被 acs_lite import |
| `acs_violations.py` | ~400 | 违规管理: 滑动窗口计分/lock/integrity chain/clear | 被 acs_lite import |
| `acs_structural.py` | ~135 | 结构变更检测: 识别文件结构破坏 | 被 acs_lite import |
| `hook_orchestrator.py` | ~230 | 统一调度器: 串联hook链、收集deny原因、统一报告 | Claude Code 入口 |
| `orchestrator_config.json` | ~40 | 调度配置: 定义哪些hook在哪个管线执行 | 被 orchestrator 读取 |
| `filesystem_guard.py` | ~280 | 文件系统保护: 阻止生产路径误写 | Pre W/E/B |
| `read_guard.py` | ~120 | 读取保护: 敏感文件拒绝, settings.json 研发模式允许 | Pre Read |
| `guard.py` | ~80 | 危险命令: rm -rf /, kill -9, mkfs, dd | 备用(未注册) |
| `sed_guard.py` | ~43 | sed 保护: 阻止 sed -i 对受保护路径修改 | Pre Bash |
| `proposal_guard.py` | ~150 | 提案审计: open-world 白名单 + is_relative_to 防遍历 | Post W/E (纯审计) |
| `abi_guard.py` | ~185 | ABI 保护: 防止接口签名被破坏 | Post W/E/B |
| `audit_hook.py` | ~86 | 审计日志: 所有写操作记录到 tool-audit.jsonl | Post W/E/B |
| `token_budget.py` | ~190 | Token 预算: 追踪消耗量 | Post All |
| `risk_engine.py` | ~370 | 风险评估: 写操作风险评分 | Post Write |
| `agent_memory.py` | ~530 | Agent 记忆: 追踪读取文件用于上下文管理 | Post Read |
| `bash_guard.py` | ~3 | 空壳: exit(0), 消除 orchestrator 噪音 | — |

### 2.2 已归档 (→ archive/orphan-hooks-v1.2.0/)

| 文件 | 原行数 | 归档原因 |
|------|--------|----------|
| `authority_invariant.py` | 412 | 未注册、未被 import、与 acs_structural 重叠 |
| `export_graph.py` | 586 | 未注册、未被 import、TypeScript 分析 |
| `governance_sdk.py` | 224 | 未注册、未被 import、AIOS SDK 遗留 |
| `prompt_compiler.py` | 403 | 未注册、未被 import、被 acs_lite 替代 |
| `shadow_workspace.py` | 435 | 未注册、CLAUDE.md 引用但未走 hook 管线 |
| `bash_guard.py`(原) | 24 | 空壳, 功能由 guard.py 覆盖 |

---

## 3. 决策路径详解

### 3.1 Write/Edit 请求 (8步)

```
1. _gate_lock()           → 系统锁检查, LOCKED 文件存在则直接 deny
2. session_feedback 豁免   → .claude/projects/*/memory/, .claude/knowledge/ 免检
3. PROTECTED 检查          → hooks/settings/governance → add_violation(100分) + deny
4. ALWAYS_WRITABLE/SHADOW  → /tmp, ~/.cache, /tmp/claude-shadow/ 直接放行
5. ZONE 检查               → SYSTEM(100分deny) / RUNTIME(60分, Edit deny) / SOURCE
6. SCOPE 检查               → allowed_dirs 匹配, 无 scope 时给 init 指引
7. SHADOW WALL             → shadow_mode 时只允许 /tmp/claude-shadow/
8. PROPOSAL GATE           → scope.proposal_required OR _infer_from_path() fallback
9. STRUCTURAL VERIFIER      → 文件已有内容时检查结构变更
```

### 3.2 Bash 请求

```
无 scope:
  → _check_baseline_command() → 38个只读命令 + BASELINE_DENY 过滤
  → 通过则放行, 拒绝则 deny

有 scope:
  → DANGEROUS_BASH 行为语义分类:
    DELETE (60): rm -rf /, rm -rf *, rm file, truncate
    WRITE  (25): chmod 777, chown root, overwrite /etc
    EXEC   (10): python3 -c, node -e  (研发模式降级为警告)
    SYSTEM (100): mkfs, dd, reboot, shutdown, fork bomb
    NETWORK(60): curl|sh, git push --force
    ACS_SELF(100): ACS 引擎/路径/配置篡改
  → scope.blocked_commands 用户自定义规则
```

### 3.3 Read 请求

```
1. SENSITIVE_FILE_PATTERNS   → .env, .ssh, .aws, /etc/shadow 绝对拒绝
2. CC_SETTINGS               → settings.json: 研发模式允许+警告, 否则拒绝
3. ALLOWED_PREFIXES          → .claude/, /tmp/, package.json 放行
4. BLOCKED_EXTENSIONS        → .ts/.tsx/.py/.js/.jsx 非研发模式拒绝
```

---

## 4. 核心机制

### 4.1 滑动窗口锁

```
WINDOW_SIZE=10     最近10个事件滚动
THRESHOLD=80        累计≥80自动锁
LOCK_DENY_SCORE=150 硬锁(不可恢复)
WINDOW_DECAY=600s   10分钟后事件衰减
```

| 类别 | 分数 | 触发条件 | 锁触发次数 |
|------|------|----------|-----------|
| ACS_SELF | 100 | 引擎篡改/配置修改 | 1次 |
| SYSTEM | 100 | mkfs/dd/reboot | 1次 |
| DELETE | 60 | rm -rf / | 1次(60+25=85) |
| NETWORK | 60 | curl|sh, git push --force | 1次 |
| WRITE | 25 | chmod 777 | 3次(25×3=75) |
| EXEC | 10 | python3 -c | 研发模式降级为0 |

### 4.2 ZONE 分区权限

| Zone | 路径 | Write | Delete | Overwrite |
|------|------|-------|--------|-----------|
| WORKSPACE | /tmp, ~/.cache | ✅ | ✅ | ✅ |
| RUNTIME | runtime/, audit/ | ✅ | ❌ | ❌ |
| SOURCE | 其他所有路径 | ✅ | ❌ | ✅ |
| SYSTEM | hooks/, settings, governance | ❌ | ❌ | ❌ |

v1.2.0 变更: audit/ 从 SYSTEM → RUNTIME (P1-4)

### 4.3 Integrity Chain (完整性链)

```
每个 entry:
  snapshot_id = UUID
  timestamp + version
  file_hashes = {15 CRITICAL_FILES: SHA256}
  parent = 前一 entry 的 entry_hash
  entry_hash = SHA256(file_hashes | parent)

验证: 遍历 chain, 检查 parent 连续 + entry_hash 一致性
任何篡改破坏整条链 (rolling hash chain 性质)

clear_violations():
  1. events = []          真清空
  2. window_score = 0      重置
  3. genesis entry         新基线 (无 hash gap)
  4. unlock               移除 LOCKED
```

### 4.4 Proposal Gate

```
v1.1.0:
  proposal_guard 在 PreToolUse → 控制流错位
  (PreToolUse 做 PostToolUse 的事)

v1.2.0:
  acs_lite 为唯一决策中心:
    needs_proposal = scope.proposal_required OR _infer_from_path()
    _infer_from_path(): open-world 白名单
      已知安全路径 → 不需要
      其余 → 需要
    is_relative_to(): 防 path traversal

  proposal_guard → PostToolUse:
    只记录审计日志, exit 0 永远不拦截
```

---

## 5. v1.2.0 变更清单

### P0 控制流重构

| ID | 问题 | 根因 | 修复 | 文件 |
|----|------|------|------|------|
| P0-1 | proposal_guard 位置错 | PreToolUse做PostToolUse语义 | 移至PostToolUse纯审计 | orchestrator_config.json, hook_orchestrator.py |
| P0-1b | scope fallback 缺失 | 双门→无门风险 | `_infer_from_path()` open-world推断 | acs_lite.py |
| P0-2 | clear 半重置 | 只追加负分, chain断裂 | events=[]+genesis baseline | acs_violations.py |
| P0-3 | 白名单 closed-world + traversal | 枚举前缀+../../绕过 | `is_relative_to()` open-world | proposal_guard.py |

### Safety Asserts

```python
assert resolved.is_relative_to(HOME)     # path不逃出HOME
assert scope is not None                  # scope必须存在
# chain: genesis_hash() → baseline  # chain必须有genesis (在clear_violations中保证)
```

### P1/P2 修复

| ID | 修复 | 文件 |
|----|------|------|
| P1-4 | audit/ 从PROTECTED→RUNTIME zone | acs_paths.py |
| P2-6 | rm -rf 正则收窄 (只拦截root/home/wildcard) | guard.py |
| P2-7 | settings.json 研发模式允许+警告 | read_guard.py |

### 基础设施

| 变更 | 文件 |
|------|------|
| DEFAULT_CONFIG 同步 v1.2.0 | hook_orchestrator.py |
| 版本号 v1.1.0→v1.2.0 (29处用户可见输出) | acs_lite.py |
| python3 -c 研发模式降级为警告 | acs_lite.py |
| 6个孤儿hook归档 | → archive/orphan-hooks-v1.2.0/ |
| bash_guard 空壳恢复 | bash_guard.py |
| settings.json 旧hook引用清理 (authority_invariant, shadow_workspace) | settings.json |
| 文档更新 (CHANGELOG/NEXT_TASK/CURRENT_STATE/PROJECT) | agent-constraint-system/ |

---

## 6. Hook 管线负载

| 管线 | Hooks | 每次延迟 | Fallback |
|------|-------|---------|----------|
| Pre Write/Edit | 2 (acs_lite + filesystem_guard) | ~80ms | missing→allow |
| Pre Bash | 3 (acs_lite + sed + filesystem) | ~120ms | 同上 |
| Pre Read | 1 (read_guard) | ~20ms | 同上 |
| Post W/E/B | 4 (abi + audit + token + risk) | ~160ms | 同上 |
| Post W/E | 1 (proposal_guard 纯审计) | ~40ms | 同上 |
| Post Read | 1 (agent_memory) | ~30ms | 同上 |
| Stop | 3 (status + stability + runtime) | ~200ms | 超时→allow |

---

## 7. 当前运行状态

```
ACS v1.2.0
├── Task:       acs-fix
├── Scope:      4 dirs (hooks, runtime, acs-project, gaokao-state)
├── Shadow:     off
├── Proposal:   off
├── Violations: window=0/80, total=0/150
├── Lock:       NO
├── Chain:      6 entries, rolling hash verified
├── Baseline:   38 readonly commands
└── Integrity:  OK
```

---

## 8. 残余待做

| # | 项 | 优先级 | 复杂度 |
|---|-----|--------|--------|
| 1 | `upgrade.sh` 版本升级脚本 (自动建目录+切symlink) | 中 | 低 |
| 2 | `hooks.json` 62KB 遗留清理 (与 orchestrator_config 重叠) | 低 | 低 |
| 3 | `ACS_ROOT` 独立安装支持 (解除 ~/.claude/ 路径依赖) | 中 | 中 |
| 4 | integrity chain TAMPERED+score=0 自动重建 | 中 | 低 |
| 5 | 废弃的 `.pyc` 缓存清理 | 低 | 低 |

---

## 9. 部署元数据

| 项 | 值 |
|------|-----|
| 版本 | v1.2.0 |
| 部署日期 | 2026-06-05 |
| 活跃 hook 文件 | 17 |
| 归档文件 | 6 |
| 代码快照 | `~/agent-constraint-system/versions/v1.2.0/` (8文件) |
| 版本 symlink | `current → versions/v1.2.0` |
| Integrity chain | 6 entries |
| CRITICAL_FILES | 15 |
| Baseline commands | 38 |
| Scope dirs | 4 |
| orchestrator config | 与 DEFAULT_CONFIG 同步 |
| settings.json | 旧hook引用已清理 |

---

*ACS v1.2.0 生产就绪。报告结束。*