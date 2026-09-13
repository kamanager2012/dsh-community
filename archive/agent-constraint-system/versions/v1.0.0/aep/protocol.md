# Agent Execution Protocol (AEP) v0.5

## 核心原则

Agent **必须先计划，再执行**。任何不经过计划的写操作视为违规。

## 执行流程

```
TASK → PLAN → APPROVE → PATCH → VERIFY → COMMIT
```

### 步骤 1：TASK

用户或系统给 agent 一个明确的任务描述。任务必须包含 scope 定义。

### 步骤 2：PLAN

Agent **必须**在执行任何写操作之前输出一个 plan。Plan 格式为 JSON：

```json
{
  "plan_id": "plan-001",
  "summary": "修复 runtime.ts 第 52 行类型错误",
  "files_to_modify": [
    "src/runtime/execution-engine.ts"
  ],
  "reason": "类型 WriteAheadLog 已被 WalInterface 替代，需更新 import",
  "risk": "low",
  "new_files": [],
  "deletions": false,
  "patch_lines_estimate": 5,
  "confidence": "high"
}
```

### 步骤 3：APPROVE

ACS 检查 plan：

- `files_to_modify` 是否在 scope 内
- `risk` 是否匹配文件类型（auth/payment/schema 必须 high）
- `deletions` 声明是否诚实
- `new_files` 是否被允许
- 高风险 plan → 人工审批

通过 → agent 可以执行。拒绝 → agent 必须修改 plan。

### 步骤 4：PATCH

Agent 只能输出 unified diff patch，**禁止**整文件覆盖。

```
--- a/src/runtime/execution-engine.ts
+++ b/src/runtime/execution-engine.ts
@@ -21,7 +21,7 @@
-import { WriteAheadLog } from "./wal.js";
+import type { WalInterface } from "./wal.js";
```

### 步骤 5：VERIFY

ACS 自动验证：

- patch 语法
- patch 文件路径符合 plan
- 修改行数不超过 plan 预估的 2x
- 没有 plan 外的副作用

### 步骤 6：COMMIT

验证通过 → 应用 patch → workspace snapshot 更新。
验证失败 → 回滚 → 要求 agent 重新输出 patch。
