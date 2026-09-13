# ACS v0.7.1 升级优化记录

**日期**: 2026-05-29
**基准**: v0.7（审计报告 `AUDIT_v0.7.md`，修复后状态见 `AUDIT_v0.7.1.md`）

---

## 修复概览

| 严重级别 | 修复前 | 修复后 |
|----------|--------|--------|
| CRITICAL | 7 | 0 |
| HIGH | 5 | 3 (H-1/H-2/H-4 涉及 Python hook 需跨语言修复) |
| 测试覆盖 | 0% (0 tests) | 14 tests, 100% pass |

---

## 已修复的 CRITICAL 问题

### C-3: `_applyPatch` — 实现真正的 unified diff 应用

**文件**: `src/patch/transaction.ts`

**修复前**: 方法体为 `return original; // placeholder`，补丁永不应用。

**修复后**: 完整实现 unified diff 算法：
- 按 `oldStart` 降序排列 hunks（避免行号偏移）
- 逐行处理 ctx/add/del
- 使用 `Array.splice` 原子替换 hunk 区域
- 支持 addition、deletion、replace、多 hunk

### C-5: rollback — 恢复原始内容

**文件**: `src/patch/transaction.ts`

**修复前**: `writeFileSync(tx.filePath, "", "utf-8")` — 写入空字符串，数据丢失。

**修复后**:
- `PatchTransaction` 新增 `beforeContent: string` 字段
- `begin()` 存储原始文件内容
- `rollback()` 直接恢复 `tx.beforeContent`

### C-4: `checkIntegrity` — 使用写入前快照

**文件**: `src/runtime/pipeline.ts`

**修复前**: `checkIntegrity` 在写入后调用两次 `integrity.snapshot(filePath)`，比较相同的快照，验证永远通过。

**修复后**:
- `lockSource(filePath)` 保存 `integrityBefore`（完整性快照）和 `astBefore`（AST 快照）
- `checkIntegrity(filePath)` 使用写入前的 `integrityBefore` 与写入后的 `afterSnap` 比较
- 文件内容只读取一次（`afterContent`），所有检查复用

### C-6: 消除 `checkCommand` 死代码

**文件**: `src/runtime/pipeline.ts`

**修复前**: `checkCommand("write")` 传入字面量 `"write"`，永远不匹配任何 blocked pattern。

**修复后**: 替换为 `_isPathWritable(filePath)`，检查目标路径是否属于受保护的 ACS 配置文件（`.claude/settings.json`、`TASK_SCOPE.json`、`VIOLATIONS.json`）。

### H-2: 路径遍历防护

**文件**: `src/constraint/scope-constraint.ts`

**修复前**: `filePath.startsWith(pattern)` 无法防止 `src/../.claude/settings.json` 绕过。

**修复后**:
- 使用 `path.resolve` + `path.normalize` 规范化路径
- 规范化后的路径与规范化后的作用域模式比较

### M-1: RiskLevel 统一大写

**文件**: `src/patch/classifier.ts`, `src/constraint/change-budget.ts`, `src/index.ts`

**修复前**: `classifier.ts` 使用 `"low" | "medium" | "high" | "critical"`，`approval-gate.ts` 使用 `"LOW" | "MEDIUM" | "HIGH" | "CRITICAL"`，互不兼容。

**修复后**: 统一为大写 `"LOW" | "MEDIUM" | "HIGH" | "CRITICAL"`，`change-budget.ts` 同步更新，`index.ts` 统一从 classifier 导出。

---

## 其他改进

| 项目 | 文件 | 改进 |
|------|------|------|
| 空作用域语义 | `scope-constraint.ts` | 空 `allowedFiles` 改为阻止所有写入（与 Python hook 行为一致） |
| 不可变 | `scope-constraint.ts` | `addViolation`/`getViolations` 使用深拷贝替代浅拷贝 |
| 魔法数字 | `scope-constraint.ts` | 提取 `VIOLATION_LIMIT`、`NEW_FILE_VIOLATION_SCORE` 等常量 |
| 魔法数字 | `classifier.ts` | 提取 `HIGH_CHANGE_COUNT_THRESHOLD`、`CODE_KEYWORDS` |
| 路径匹配 | `patch.ts` | `validate` 添加 `endsWith("/" + patch.filePath)` 后缀匹配 |
| 文件读取 | `pipeline.ts` | 从 4+ 次减为 1 次，内容复用 |
| 写预算 | `pipeline.ts` | `recordWrite` 不再硬编码 `deletions = 0`，依据原文件行数计算 |

---

## 修改文件清单

| 文件 | 变更类型 |
|------|----------|
| `src/patch/transaction.ts` | 🔧 重写 `_applyPatch` + 修复 `rollback` + `validate` 优化 |
| `src/runtime/pipeline.ts` | 🔧 修复 `checkIntegrity` + 新增 `_isPathWritable` + 减少文件读取 + **AEP 集成** |
| `src/constraint/scope-constraint.ts` | 🔧 路径规范化 + 空作用域修复 + 不可变修复 |
| `src/patch/classifier.ts` | 🔧 RiskLevel 统一大写 + 提取常量 |
| `src/constraint/change-budget.ts` | 🔧 RiskLevel 键名同步 |
| `src/patch/patch.ts` | ➕ validate 后缀匹配 |
| `src/index.ts` | 🔧 统一 RiskLevel 导出 |
| `aep/execution-protocol.ts` | 🔧 RiskLevel 大写同步 |
| `aep/index.ts` | 🔧 修复 JSDoc 注释冲突 |
| `.claude/hooks/acs_engine.py` | 🔧 完全重写：受保护路径、正则 file-write 向量、路径规范化、危险命令 |
| `tsconfig.json` | 🔧 移除 rootDir 限制，include aep + tests |
| `tests/critical-fixes.test.ts` | ➕ 14 个 TS 核心修复测试 |
| `tests/aep-integration.test.ts` | ➕ 8 个 AEP 集成测试 |
| `tests/hook-full.test.py` | ➕ 77 个 Python Hook 测试 |
| `tests/hook-fixes.test.py` | ➕ 15 个 Python 快速测试 |

---

## 测试覆盖

**22 个 TypeScript 测试 + 92 个 Python 测试，全部通过**:

```
TS (vitest):
  ✓ critical-fixes.test.ts    14 tests
  ✓ aep-integration.test.ts    8 tests

Python (hook-full.test.py):
  ✓ PROTECTED STATE FILES         9 tests
  ✓ PATH NORMALIZATION           3 tests
  ✓ PATH FREEZE                  5 tests
  ✓ FILE-WRITE VECTORS (C-1)    22 tests
  ✓ DANGEROUS COMMANDS          14 tests
  ✓ SAFE COMMANDS               25 tests

Python (hook-fixes.test.py):
  ✓ C-1/C-2/H-1/H-4/H-5        15 tests
```

---

## 仍未修复（跨语言协调已完成）

| 问题 | 状态 | 说明 |
|------|------|------|
| ~~C-1: Bash 完全绕过~~ | ✅ 已修复 | `python3 -c`, `node -e`, shell `>`, `tee`, `dd`, `curl -o`, `wget -O` 等 15+ 种 file-write 向量全部被正则检测拦截 |
| ~~C-2: 违规计数器重置~~ | ✅ 已修复 | `VIOLATIONS.json`、`TASK_SCOPE.json`、hook 自身、`.env`、`.env.*` 均加入 `_PROTECTED_PATTERNS` 白名单 |
| ~~H-1: 路径遍历~~ | ✅ 已修复 | `os.path.realpath()` + `os.path.normpath()` 路径规范化，`../` 逃逸被阻止 |
| ~~H-4: Bash 模式匹配强化~~ | ✅ 已修复 | 从子串匹配升级为正则匹配，支持 `rm -r -f`、`rm -rf` 等任意空格变体 |
| ~~H-5: Settings 可被覆写~~ | ✅ 已修复 | `settings.json` 和 `acs_engine.py` 自身加入受保护路径 |
| ~~C-7: AEP-Pipeline 断连~~ | ✅ 已修复 | `Pipeline` 新增 `aep: AEP` 属性，`checkWrite` 在 `requirePatch=true` 时强制检查 plan；新增 `submitPlan`/`commit`/`abortPlan` API；`checkIntegrity` 集成 AEP 行数预算验证 |

---

## 后续路线

- **v0.7.2**: 修复 Python hook 侧的 C-1、C-2、H-1、H-4
- **v0.8**: 连接 AEP ↔ Pipeline，统一 RiskLevel 路径定义，实现 Constraint 注册模式
- **v0.9**: 替换 Regex AST 为 TypeScript Compiler API，E2E 测试
- **v1.0**: 生产就绪
