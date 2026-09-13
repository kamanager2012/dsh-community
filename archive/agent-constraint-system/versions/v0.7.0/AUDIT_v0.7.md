# ACS v0.7 全面审计报告

**审计日期**: 2026-05-29
**审计范围**: 全部源文件（17 `.ts`）、hook 引擎（`acs_engine.py`）、AEP 协议、运行时状态
**审计方法**: 三代理并行审计（security-reviewer + code-reviewer + architect）

---

## 一、总体评估

| 维度 | 评分 | 状态 |
|------|------|------|
| 类型安全 | ✅ 通过 | `tsc --noEmit` 零错误 |
| 测试覆盖 | ❌ 0% | 审计时零测试文件 |
| 安全性 | 🔴 严重缺陷 | 7 CRITICAL 漏洞 |
| 代码质量 | 🟡 需修复 | 2 CRITICAL, 5 HIGH |
| 架构完整性 | 🟡 需重构 | 2 CRITICAL 结构问题 |
| AEP 实现度 | ~20% | TASK→PLAN→APPROVE→PATCH→VERIFY→COMMIT 未完整实现 |

**综合判定: BLOCK — 不建议生产使用。**

---

## 二、CRITICAL 问题（7 项）

| # | 标题 | 影响 | 位置 |
|---|------|------|------|
| C-1 | ACS 完全绕过 — Bash 可写任意文件 | Agent 通过 `python3 -c` / `node -e` / shell 重定向执行任意代码 | `acs_engine.py:117-130` |
| C-2 | 违规计数器可无限归零 | `VIOLATIONS.json` 通过 Bash 重置 | `acs_engine.py:60-63` |
| C-3 | `_applyPatch` 空操作 | 补丁系统完全不工作 | `transaction.ts:193-197` |
| C-4 | `checkIntegrity` 自比较 | 完整性验证始终通过 | `pipeline.ts:115-125` |
| C-5 | rollback 写空字符串 | 回滚破坏数据而非恢复 | `transaction.ts:133-136` |
| C-6 | 双重执行路径 + 状态分裂 | Python hook 与 TS Pipeline 独立运行，状态不共享 | 全局架构 |
| C-7 | AEP 与 Pipeline 无连接 | 协议实现度 ~20% | `aep/` → `pipeline.ts` |

---

## 三、HIGH 问题（5 项）

| # | 标题 | 位置 |
|---|------|------|
| H-1 | 路径遍历绕过作用域（`src/../.claude/settings.json`） | `acs_engine.py:100`, `scope-constraint.ts:66` |
| H-2 | 覆写 `settings.json` 可禁用 ACS | `acs_engine.py` 整体 |
| H-3 | `checkCommand("write")` 永远不匹配 | `pipeline.ts:63` |
| H-4 | Bash 模式匹配简单子串可绕过 | `acs_engine.py:127-129` |
| H-5 | 源锁路径哈希冲突 | `source-lock.ts:100-102` |

---

## 四、MEDIUM 问题（15 项）

- RiskLevel 三处独立定义，大小写不一致
- HIGH_RISK_PATHS 重复定义
- `ChangeBudget` 死代码（零调用者）
- 添加约束需修改 5-6 个文件
- `WorkspaceSnapshot` 与 `RollbackEngine` 存储不一致
- `checkIntegrity` 同一文件读取 4+ 次
- 空 `allowedFiles` 语义冲突（Python 阻止 vs TS 允许）
- `readViolations` 静默吞错误
- `_walk` 跟随符号链接可无限递归
- 伪不可变（shallow copy）
- `_classifyLine` 始终报告 line:0
- `simulate()` 子串搜索非精确匹配
- 三个方法超过 50 行限制
- Regex AST 解析缺失箭头函数/泛型/装饰器
- `maxChangedLines` 死字段

---

## 五、LOW 问题（12 项）

- 硬编码魔法数字（100, 200, 20）
- 空 catch 块
- `BudgetLimit` 接口未导出
- 缺少 JSDoc
- 审批后丢弃历史记录
- `recordWrite` 硬编码 deletions=0
- `\ No newline` 标记未处理
- 等 12 项

---

## 六、架构分析

### 系统分层

```
┌──────────────────────────────────────┐
│  .claude/settings.json               │  钩子注册
│  ├─ Write/Edit → acs_engine.py       │  实际执行边界
│  └─ Bash → acs_engine.py            │
├──────────────────────────────────────┤
│  acs_engine.py (Python)              │  Hook Engine
│  ├─ check_file_write / check_bash    │
│  └─ State: TASK_SCOPE.json,          │
│            VIOLATIONS.json            │
├──────────────────────────────────────┤
│  src/ (TypeScript)                  │  Runtime API
│  ├─ constraint/ (scope, freeze,     │
│  │   write/change budget)          │
│  ├─ integrity/ (AST, semantic,    │
│  │   manifest, source-lock)         │
│  ├─ patch/ (parser, classifier,    │
│  │   transaction)                 │
│  ├─ runtime/ (pipeline, rollback,  │
│  │   approval, freeze, snapshot)    │
│  └─ audit/ (violation-log)         │
├──────────────────────────────────────┤
│  aep/                              │  Agent Execution Protocol
│  └─ ~20% 实现                      │
└──────────────────────────────────────┘
```

### 核心架构问题

1. **双重引擎**: Python hook 与 TS Pipeline 独立运行，状态不共享
2. **AEP 断连**: Plan→Approve→Patch→Verify→Commit 与 Pipeline 无集成
3. **无扩展机制**: 添加新约束需修改 5-6 个文件

### 安全绕过链

```
步骤 1: Bash → python3 -c 执行任意代码
步骤 2: 覆写 VIOLATIONS.json → 违规计数器归零
步骤 3: 覆写 TASK_SCOPE.json → 作用域扩展为 /**
步骤 4: 覆写 .claude/settings.json → 移除所有 ACS hook
结果: ACS 完全且不可逆被绕过
```

### AEP 实现缺口

| 步骤 | 状态 |
|------|------|
| TASK | ❌ 未实现 |
| PLAN | ⚠️ 仅结构验证 |
| APPROVE | ⚠️ 自动通过 |
| PATCH | ⚠️ 仅格式检查 |
| VERIFY | ❌ 未实现 |
| COMMIT | ❌ 未实现 |

---

## 七、代码统计

| 指标 | 值 |
|------|-----|
| 源文件 | 17 `.ts` + 1 `.py` |
| 总行数 | 1,977 行 |
| 最大文件 | 198 行 |
| 循环依赖 | 0 |
| 类型检查 | 通过 |
| 测试覆盖 | 0%（审计时） |
| `any` 使用 | 0 |

### 设计优点

- 零信任哲学正确
- PreToolUse 拦截点正确
- 模块化清晰
- 类型系统健壮
- 无循环依赖
- 一致的结果类型 `{ ok, errors }`

---

*审计由 security-reviewer + code-reviewer + architect 代理并行执行。*
