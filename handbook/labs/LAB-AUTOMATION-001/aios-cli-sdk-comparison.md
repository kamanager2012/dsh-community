# AIOS：CLI 与 Python SDK 对照实验

这是 `LAB-AUTOMATION-001` 的具体执行卡。它复用 [`LAB-BOOT-001` 的 AIOS 只读任务契约](../LAB-BOOT-001/aios-readonly-task.md)，只改变调用入口和 session 生命周期，不改变任务目标。它是实验设计，不是运行结果。

## 实验问题

同一份任务契约经过不同入口后，以下边界是否仍然可观察、可验收：

```text
任务输入
  → workspace
  → Provider/model
  → session 生命周期
  → 工具/事件
  → 最终结果
  → 退出码或异常
  → 外部 clean-diff
```

核心比较不是“哪个入口更聪明”，而是“哪个事实由哪一层负责证明”。

## 固定变量

| 变量 | 固定方式 |
| --- | --- |
| dsh CLI | `@deepseek-ai/dsh@0.1.0-rc.6` |
| 官方源码 | `47f943859bef60e4160492346772ded9b24f765a` |
| workspace | `aios-core@6af8968` |
| 任务 | [AIOS 只读任务契约](../LAB-BOOT-001/aios-readonly-task.md) |
| 权限起点 | `read-only`；若 SDK 组合无法表达同等限制，必须停止并记录差异 |
| session root | 独立临时目录，不放在 workspace 或仓库中 |
| 凭据 | 只从外部运行环境注入，不写进命令、日志或证据 |

AIOS 基线和既有排除项见 [`AIOS-WORKSPACE-BASELINE-2026-08-14.yaml`](../../evidence/records/AIOS-WORKSPACE-BASELINE-2026-08-14.yaml)。Python SDK 的固定源码行为见 [`SOURCE-PYTHON-SDK-47F9438-2026-08-14.yaml`](../../evidence/records/SOURCE-PYTHON-SDK-47F9438-2026-08-14.yaml)。

## 执行矩阵

| Run | 入口 | 输入 | session 预期 | 主要观察 |
| --- | --- | --- | --- | --- |
| A0 | CLI headless | AIOS 只读契约 | 每次调用新建持久化 Agent | stdout、stderr、退出码、最终文本、session 引用 |
| B0 | Python SDK | 同一契约 | `DeepSeekHarness` 上下文内运行一个新 `session_id` | `RunResult` 字段、根事件、通知、异常 |
| B1 | Python SDK | 同一 SDK 对象、同一 `session_id` 的第二次提示 | 观察是否落在同一 session 活动边界 | session ID、事件追加、状态/上下文边界；不把模型记忆当作唯一证据 |
| B2 | Python SDK | 同一 SDK 对象、新 `session_id` | 观察新 session 是否独立 | 新旧 session 标识、事件根、workspace 状态 |
| F0 | CLI 或 SDK | 缺凭据或明确的启动前置错误 | 不进入模型任务 | 错误类型、退出码/异常、是否产生 session 事件 |

`A0`、`B0`、`B1`、`B2` 只有在真正完成模型请求后才可标记为运行过。`F0` 的缺凭据结果只能证明前置失败路径，不能替代成功路径。

## 运行顺序

### 1. 外部前置

1. 在执行前记录 dsh、Python、SDK、平台、Provider、模型和 workspace 指纹；
2. 确认 `cc-switch.db`、秘密文件、`node_modules/` 和 workspace 外路径不在读取范围；
3. 创建独立 session root，并确保它不在仓库内；
4. 保存 workspace 的初始 `git status --short`、`git diff --stat` 和必要的文件清单指纹；
5. 先以只读策略运行，不因为 SDK 的默认组合而自动提高权限。

### 2. CLI A0

```sh
DSH_PERMISSION_MODE=read-only \
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  --profile headless "<AIOS 只读任务契约中的任务文本>"
```

捕获 stdout、stderr 和退出码。不要把 stdout 非空当作成功；必须同时检查最终原因、工具事件可用性、任务文本要求和 workspace diff。

### 3. SDK B0/B1/B2

使用官方 SDK 的公开 `DeepSeekHarness` / `RunResult` 接口。实验代码只负责：

- 给每个 run 分配可关联但不含隐私的 `session_id`；
- 保存 `final_response`、`finish_reason`、`events` 数量/类型摘要、`notifications` 数量/类型摘要和 `session_root` 脱敏引用；
- 区分 `RunResult`、异常、runtime stderr 和进程退出；
- 在上下文管理器退出后确认子进程被回收；
- 对同一 SDK 对象的同 session 与新 session 做对照。

不要把完整 JSONL、工具参数、消息原文或模型输出原样提交到手册。先脱敏，再保存摘要和哈希；原始材料留在受控位置。

## 通过条件

### 入口层

- CLI 与 SDK 都确实完成模型请求；
- 版本、Provider、模型、平台和权限已记录；
- 两条路径使用同一份任务契约，不能偷偷改变目标或范围。

### 结果层

- CLI 的 stdout、stderr、退出码和最终原因可以分开解释；
- SDK 的 `final_response`、`finish_reason`、`events`、`notifications` 和异常可以分开解释；
- `events` 与 `notifications` 的范围差异有实际记录，而不是只复述源码说明；
- 同一 session 与新 session 的边界有 session 标识和事件证据；
- 不能用模型最后一句话代替工具事件或外部验收。

### workspace 层

- 任务没有新增、修改、删除或重命名文件；
- 预先存在的 `cc-switch.db` 仍未被触碰；
- 前后 `git status --short`、`git diff --stat` 和必要指纹一致；
- session root 不污染 workspace。

### 失败层

- 缺凭据、模型错误、SDK 协议错误、超时、非零退出和 workspace 越权分别分类；
- 任何一个失败都不会被包装成“任务完成”；
- 清理动作不会覆盖失败现场或删除未经确认的用户数据。

## 证据登记模板

每个 Run 单独登记，不把 CLI 和 SDK 的结果混成一条：

```yaml
run_id: "AUTOMATION-<A0|B0|B1|B2|F0>-<date>"
layer: F2
status: "pass | fail | blocked | superseded"
entrypoint: "cli-headless | python-sdk"
package_version: "..."
source_commit: "..."
python: "..."
provider: "..."
model: "..."
workspace_ref: "sanitized fingerprint"
session_ref: "sanitized identifier"
session_root_ref: "sanitized path or hash"
exit_code: null
finish_reason: null
result_summary: "..."
events_summary: "counts/types only"
notifications_summary: "counts/types only"
workspace_diff: "empty | unexpected | not_checked"
limitations:
  - "..."
```

模板中的 `null` 和占位符不能直接作为完成证据；运行后必须用真实观察值替换，未观察字段继续标记为未验证。

## 当前状态

实验规范、AIOS 任务契约和 Python SDK 固定源码记录已就绪。当前没有凭据，因此 A0/B0/B1/B2 的成功路径尚未运行；既有缺凭据探针只能作为 F0 前置失败基线。
