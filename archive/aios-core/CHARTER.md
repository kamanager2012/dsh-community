# AIOS Core — Charter V1

> 生效日期: 2026-06-14
> 状态: **ACTIVE — 可演化，但遵守以下约束**

---

## 0. 一句话定义

```
AIOS Core = 用项目状态驱动 Agent 的开发项目执行内核。
不是操作系统。不是平台。
让 Agent 长期稳定地开发一个项目。
```

---

## 1. 核心原则

1. **项目状态驱动** — Agent 由项目事实和决策驱动，不是由上下文驱动
2. **单 Agent** — 任何时刻只有一个执行主体
3. **先谋后动** — 所有写操作必须 PLAN → (approval) → EXECUTE → VERIFY → COMMIT
4. **可回滚** — 任何写操作配套 rollback 路径
5. **项目记忆是核心** — 持久化项目事实和决策；不存人类聊天、模型思考、向量
6. **不自治演化** — 不自行升级依赖、改 schema、改 capability scope
7. **治理是护栏不是引擎** — governor 拦住不该做的事，但不驱动该做的事

---

## 2. 目录（冻结）

```
aios-core/
├── kernel/       # 执行内核: planner + executor + verifier + reconciler + runtime + schema
├── memory/       # 项目记忆: current/ tasks/ decisions/ architecture/ incidents/ staging/ snapshots/
├── governor/     # 治理护栏: scope + approval + rollback + audit
├── cli/          # 入口: aios discover | plan | execute | verify | commit
├── tests/        # 测试
├── scripts/      # 运维
└── docs/         # 文档
```

**严格禁止新增顶层目录。**

---

## 3. 状态机（6 状态）

```
IDLE → PLAN → EXECUTE → VERIFY → COMMIT → DONE
```

异常路径:

```
VERIFY_FAIL → ROLLBACK → DONE
```

**注意**: APPROVAL 不是状态，是 Plan 的属性。

| Plan.approval | 含义 |
|---|---|
| `"AUTO"` | 不需人工确认，内核自动放行 |
| `"MANUAL"` | 需人工确认后才进入 EXECUTE |

**注意**: RETRY 不是状态，是执行属性 (executor 内部重试 ≤ maxRetries)。

**注意**: BUDGET 不是状态，是终止条件 (limits.ts: maxTurns, maxContext, maxRetries)。

---

## 4. 项目记忆（三层）

### Current（热） — 当前事实

```json
{
  "goal": "完成登录模块",
  "active_task": "task_102",
  "branch": "feature/auth",
  "phase": "PLAN"
}
```

唯一可覆盖的目录。COMMIT 独占写权限。

### Decisions（温） — 为什么这么做

```json
{
  "id": "dec_042",
  "decision": "不用 Redis",
  "reason": "规模不足",
  "at": "2026-06-14T..."
}
```

Append-only。不删不改。

### Tasks + Architecture + Incidents（冷） — 做过什么 / 项目结构 / 失败记录

Append-only。不删不改。

**Memory 生成规则**:

```
Task + Current + 最近 5 个 Decision + 相关 Task = Agent Context
```

**禁止全量历史注入。**

---

## 5. Memory 写入纪律

**只有 COMMIT 能写正式 memory。**

| 目录 | 谁写 | 写时机 | 可变性 |
|---|---|---|---|
| `current/` | COMMIT | 状态推进 | **唯一可覆盖** |
| `tasks/` | COMMIT | 任务完成 | append-only |
| `decisions/` | COMMIT | 决策落地 | append-only |
| `architecture/` | COMMIT | 结构变更 | append-only |
| `incidents/` | ROLLBACK | 失败复盘 | append-only |
| `staging/` | EXECUTE | 执行中暂存 | 执行结束清空 |
| `snapshots/` | COMMIT | promote 前 | 只读参考 |

**违反 = 状态污染。**

---

## 6. Reconciler（系统核心）

**唯一允许**: 更新状态、写记忆、触发回滚。

**禁止**: 调模型、执行命令、写文件（除 memory）。

输入:

```
plan, execute_result, verify_result, project_state
```

输出:

```
{ decision, memory_update }
```

project_state 只读: current + 最近 N 个 decision + 最近 N 个 task。
禁止全量历史。

---

## 7. Governor（护栏）

| 模块 | 职责 |
|---|---|
| scope.ts | 目录/命令/文件类型/危险操作白黑名单 |
| approval.ts | AUTO/MANUAL 两级（Plan 属性，不是状态） |
| rollback.ts | git restore / git revert / snapshot |
| audit.ts | append-only 日志 (时间/任务/输入/执行/结果) |

**红线**: governor 不包含业务逻辑。不改 memory 内容，不调 planner，不改 executor 行为。

---

## 8. Limits（终止条件，不是预算）

```ts
limits.ts {
  maxTurns: number,      // 单次执行最大步骤数
  maxContext: number,    // 单次注入最大 token 数
  maxRetries: number,    // executor 内部最大重试数
}
```

不是 budget。不是 cost。是终止条件。

---

## 9. ACS 替代路线

| 阶段 | ACS | AIOS Core | 状态 |
|---|---|---|---|
| 1 Shadow | 主 | 只读对照 | 当前 |
| 2 Execute | 审批 | 执行 | 阶段 1 完成后 |
| 3 Primary | 熔断 | 审批 + 执行 | 阶段 2 完成后 |
| 4 Replace | 退役 | 完整接管 | 阶段 3 完成后 |

---

## 10. 明确不做

```
❌ 多 Agent
❌ 预算 / 成本追踪
❌ 向量库 / 知识图谱
❌ 人格记忆
❌ 工作流编排
❌ 经济系统
❌ Mesh
❌ 自动演化
❌ 复杂权限 (L1/L2/L3)
❌ 云调度
```

只做: 项目记忆、执行、治理、恢复。

---

## 11. 与 9.0 的关系

9.0 是冻结基线 (`/home/jamesoldman/aios-9.0/`)。
Core 是演化主线 (`/home/jamesoldman/aios-core/`)。

继承的纪律:
- Reconciler 是唯一决策出口，禁止调模型
- 只有 COMMIT 写正式 memory
- Memory append-only
- Governor 无业务逻辑
- staging/snapshot 机制

重建的部分:
- 状态机 (6 状态替代 9 状态)
- Approval (AUTO/MANUAL 替代 L1/L2/L3)
- Limits (终止条件替代 budget)
- Reconciler 接口 (加 projectState 输入)
- Rollback (独立模块替代 executor 内嵌)
