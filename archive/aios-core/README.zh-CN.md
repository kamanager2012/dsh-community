# 已归档

本仓库已冻结。它不是对外产品，也没有发布到 npm。npm 上的 `aios-core` 属于 [SynkraAI](https://www.npmjs.com/package/aios-core)，不是这个仓库。

当前公开 Outcome：[dsh-community](https://github.com/kamanager2012/dsh-community)。[English](README.md)。

---

# AIOS Core

> Agent Reliability Kernel — 面向 Coding Agent 的任务契约、证据门、确定性回放、回归与跨 Agent Eval 内核。

AIOS Core 正在把原来的三层 **Agent Governance Stack** 收敛成一个 canonical reliability 项目。目标不是再造 Agent Loop、Sandbox 或模型 Router，而是回答两个更实际的问题：**Agent 声称完成后，能不能用证据证明它真的完成；Agent / 模型 / Policy 升级后，能不能量化回归。**

## 核心思想

```text
Task Contract
    ↓
PLAN → EXECUTE → VERIFY
                  ↓
             Evidence Gate
              ↙        ↘
          COMMIT      ROLLBACK
              ↓
        Audit / Replay
              ↓
          Regression

Canonical Policy ─→ Vendor Adapter / Native Controls
Policy Eval Corpus ─→ Agent / Vendor Observation ─→ Eval Report
```

模型越强，不代表不需要验证；只是验证重点从“限制模型每一步”转向“证明最终结果成立，并确认升级没有回归”。底层 sandbox / network / permission 优先使用各 Agent Runtime 原生能力。

## Task Contract

任务契约定义任务被接受前必须具备的最低证据：

```ts
const contract = {
  version: 1,
  requiredEvidence: ["test", "build", "diff"],
  invariants: ["public-api-stable"],
  acceptance: {
    minTestsPassed: 20,
  },
};
```

Verifier 当前会产生 build、test、lint、E2E、diff 的结构化证据；外部 adapter 可以补充 policy、artifact、命名 invariant 等证据。命名 invariant 必须有明确 ID：

```ts
{
  kind: "invariant",
  id: "public-api-stable",
  status: "pass",
  summary: "export surface unchanged",
}
```

Reliability Gate 输出：

- `PASS` — 所有必需证据和命名 invariant 均满足。
- `FAIL` — 必需证据存在，但失败或不满足验收阈值。
- `INCOMPLETE` — 必需证据缺失，不能把任务当成完成。

没有 Task Contract 的旧任务继续保持原有 verify-pass 行为。

## 架构

```text
aios-core/
├── kernel/
│   ├── runtime.ts       # 状态机唯一驱动器（SSOT）
│   ├── planner.ts       # Task → 冻结 Plan
│   ├── executor.ts      # 执行适配边界
│   ├── verifier.ts      # 结构化验证证据
│   ├── reliability.ts   # 任务 Evidence Gate + run 回归比较
│   ├── eval.ts          # vendor-neutral Policy Eval 结果裁决
│   ├── reconciler.ts    # 唯一确定性 COMMIT / ROLLBACK 决策出口
│   ├── replay.ts        # 确定性 Audit Replay + 派生 Reliability Verdict
│   ├── invariant.ts     # 状态不变量
│   ├── failure.ts       # 失败分类
│   └── statehash.ts     # 执行指纹 + Hash Chain
├── governor/
│   ├── policy.ts        # canonical policy schema / validation / normalization
│   ├── scope.ts         # 确定性路径 / 命令语义
│   └── ...              # approval / rollback / audit / limits + legacy adapters
├── memory/              # 项目状态记忆与 staging
├── shadow/evals/        # 有来源 pin 的 Eval 语料；不进入 npm 发布面
├── cli/
└── tests/
```

### 状态机保持冻结

```text
IDLE → PLAN → EXECUTE → VERIFY → COMMIT → DONE
                         │
                         └──────→ ROLLBACK → DONE
```

Reliability 重构**不增加任何状态**。Evidence Gate 位于现有 VERIFY → decision 边界内，不制造第二套状态机。

## Canonical Policy 语义层

`governor/policy.ts` 是纯数据、vendor-neutral 的 policy 层，负责：

- 严格 schema validation
- 确定性的 trim / 去重 normalization
- 字段级 overlay；显式 `[]` 必须保持为空，不能偷偷回退默认值
- 给 vendor adapter 使用的可选 `elevatedCommands`、`askPaths`、`askCommands` 提示

`governor/scope.ts` 使用同一 schema，负责确定性的：

- 项目相对路径 normalization 与 traversal 拒绝
- command chain 拆分
- quoted literal 处理
- command substitution 检查
- 简单变量间接展开
- mass-delete 语义信号
- shell 写入目标提取
- 通用解释器 / build tool elevated 信号

这一层**不是 OS 安全边界**，而是统一的 policy 语义与测试面；后续 adapter 再把它翻译成 Codex / Claude / Gemini 等 Runtime 的原生控制能力。

默认 AIOS CLI 现在直接创建 canonical `ScopeValidator`，**不再实例化或读取 ACS runtime state**。Legacy ACS compatibility 暂时保留为显式 opt-in 的最小结构接口，旧 adapter 后续再分阶段淘汰。

这一轮只增强解析语义，不把 `governor-core` 更宽的默认 policy profile 原样替换 AIOS 当前默认 allow/deny 策略，避免“迁算法顺手改变业务策略”。

## Audit / Replay

形式化约束仍然是：

```text
state = f(audit_log[0..n])
```

Reliability Verdict 刻意不再单独写一份可变状态，而是从已经进入 Audit 的 frozen Task Contract 与 Verification Evidence 中确定性重算：

```text
reliability_verdict = g(frozen_task_contract, verification_evidence)
```

这样避免“双真相”：Live Reconciler 和 Replay 使用同一个纯函数；同时 contract 与 evidence 已进入 audit/hash-chain 输入，因此裁决依据仍可验证。

## Agent CI Regression

`kernel/reliability.ts` 按稳定 `taskId` 比较 Agent / 模型版本运行结果，输出：

- regression：`PASS → INCOMPLETE/FAIL`、`INCOMPLETE → FAIL`
- improvement
- 未变化任务
- candidate 缺失任务
- candidate 新增任务

目标是面向真实项目的 **Agent CI**，不是通用 Benchmark 排行榜。

## Vendor-neutral Policy Eval

`kernel/eval.ts` 不执行任何命令，只负责把不同 Agent / Vendor adapter 产出的 observation 与固定 case 进行统一裁决，明确区分：

- `false_allow` — 应拒绝却放行
- `false_deny` — 应放行却阻止
- `unexpected_ask` — Runtime 转成人工确认，没有命中固定 expectation
- `missing_observation` — adapter 没有产出结果

输出 accuracy、danger-block rate、false-positive rate、分类结果以及版本间 PASS→FAIL 回归。

### ACS 语料迁移

`agent-constraint-system` 中真正有长期价值的部分已经迁到 `shadow/evals/policy/acs-v1/`：保留 benchmark case、known bypass、false positive 与来源，不复制 ACS runtime。

迁移 gate 已 pin 原仓库 revision，并硬性要求 **105 条**场景全部存在、ID 唯一。源报告里 6 个已知失败继续保留，包括 4 个 bypass 和 2 个合法清理命令 false positive；迁移过程中禁止通过改 expectation 把失败“洗成成功”。

## 原三项目如何收敛

| 原项目 | 在 canonical 项目里保留什么 |
|---|---|
| `agent-constraint-system` | benchmark corpus、known bypass / false positive、constraint taxonomy、可选 legacy adapter evidence |
| `governor-core` | canonical policy schema、解析 / normalization 语义、adversarial test 经验；不搬通用 GovernanceEngine 产品壳 |
| `aios-core` | 状态机、证据验证、invariant、failure recovery、replay、rollback、project-state memory |

Codex / Claude / Gemini 等 Runtime 已原生支持的 sandbox、permission、network policy 等能力，优先调用上游，不重做第二套。

## 安装

```bash
git clone https://github.com/kamanager2012/aios-core.git
cd aios-core
npm install
```

## 用法

```bash
aios run "fix login bug" --project myapp
aios plan "fix login bug" --project myapp
aios status
aios replay --last
aios replay --task task_042
```

CLI 命令面保持兼容；canonical 执行现在不再要求 ACS runtime 文件存在。Task Contract、Reliability、Eval、Policy API 通过 package API 暴露，CLI 继续保持窄接口。

## 验证

```bash
npm run check
```

`check` 会执行 architecture guard、TypeScript typecheck、完整 Vitest，以及 Eval corpus 完整性与 canonical policy boundary 检查。

## 设计约束

- Runtime 是唯一状态机驱动器。
- Reconciler 是唯一决策出口，保持纯函数：禁止模型调用、禁止 IO。
- Task Contract 只能让验收更严格，不能绕过原有 verification 失败。
- 缺少必需证据绝不等于成功。
- 命名 invariant 必须是真正可验证的 acceptance requirement，不能只是文档字段。
- Reliability Verdict 必须由 audited inputs 派生，不能维护第二份可漂移真相。
- Canonical policy 只负责纯数据 / 决策语义，不冒充第二套 Sandbox。
- 默认 CLI / runtime / scope 不得依赖具体 ACS runtime 模块。
- Eval corpus 是数据，Vendor 执行逻辑在 adapter 边界之后。
- 项目记忆只保存项目事实和决策，不保存聊天、模型思考或向量人格记忆。
- staging / snapshot 隔离执行中状态，只有 COMMIT 才 promote。

## 不做什么

AIOS Core 不做：

- 新的通用 Agent Loop
- Multi-Agent Mesh / 通用编排框架
- 第二套 Sandbox / 网络隔离层
- 模型 Router
- 向量记忆 / 人格系统
- 云调度 / 自动经济系统

目标收窄为：**为真实 Coding Agent 工作提供可靠的执行验收和回归证据。**

## 贡献

架构硬限制（`scripts/arch-guard.mjs`）、设计约束和测试约定见 [CONTRIBUTING.md](CONTRIBUTING.md)（英文）。

## 安全

安全问题范围（Evidence Gate 绕过、审计链篡改、replay/reconciler 正确性、scope/policy 解析）和私密报告方式见 [SECURITY.md](SECURITY.md)（英文）。

## License

MIT

---

[English](./README.md)
