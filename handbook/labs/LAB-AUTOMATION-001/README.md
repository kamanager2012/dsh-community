# LAB-AUTOMATION-001：Headless 与 Python SDK 任务契约

状态：`planned`（执行规范已完成；真实模型路径未运行）

## 目标

在同一个版本矩阵下，分别用 headless CLI 和 Python SDK 执行一条只读任务，比较它们的输入、输出、退出状态、workspace 边界、session 持久化和验收证据。

## 不做什么

- 不比较模型“聪明程度”；
- 不把 CLI stdout 当作完整轨迹；
- 不在真实生产仓库运行；
- 不复用任何外部文章的示例、日志或账单；
- 不把 SDK 示例中的宽权限组合直接当成生产建议。

## 前置条件

- 固定 dsh 发布包和 Python SDK 版本；
- Python 3.10+、Git、受支持平台；
- 可丢弃 workspace 和独立 session root；
- 凭据从外部环境注入；
- 可独立运行的 diff / 测试验收器。

已完成的前置失败基线：[`HEADLESS-MISSING-CREDENTIAL-2026-08-14.md`](../../evidence/records/HEADLESS-MISSING-CREDENTIAL-2026-08-14.md)。它只覆盖缺凭据错误，不替代有凭据的成功路径。

首个真实 workspace 的对照执行卡：[`aios-cli-sdk-comparison.md`](aios-cli-sdk-comparison.md)。它复用 [`LAB-BOOT-001` AIOS 只读任务契约](../LAB-BOOT-001/aios-readonly-task.md)，只改变入口和 session 生命周期。

固定源码的 Python SDK 事实：[`SOURCE-PYTHON-SDK-47F9438-2026-08-14.yaml`](../../evidence/records/SOURCE-PYTHON-SDK-47F9438-2026-08-14.yaml)。它不是已发布 SDK 的运行结果。

## 计划步骤

1. 记录 Node、Python、dsh、SDK、平台和 Provider，不记录凭据；
2. 用 headless 执行只读任务，保存 stdout、stderr、exit code 和脱敏 session 引用；
3. 用 Python SDK 执行同一任务契约，保存最终结果、通知摘要和 session JSONL 指纹；
4. 检查两条路径的 workspace diff 是否为空；
5. 使用新 session 重跑，比较状态是否被意外继承；
6. 在隔离条件下人为触发一个可预期失败，记录错误层级和退出状态；
7. 清理 workspace、session root 和临时凭据引用。

具体 Run 编号固定为：

- `A0`：CLI headless，只读任务；
- `B0`：Python SDK，新 session；
- `B1`：同一 SDK 对象、同一 session 的第二次运行；
- `B2`：同一 SDK 对象、新 session 的运行；
- `F0`：缺凭据或其他启动前置失败。

每个 Run 单独登记 Evidence Record；不把 SDK 的 `RunResult`、CLI stdout 或模型最终文本互相当作替代证据。

## 通过条件

- 两条路径的版本和环境都已记录；
- 只读任务没有未预期 workspace diff；
- CLI 退出码、SDK result/exception 和最终文本可区分；
- 新旧 session 的状态边界有证据；
- 失败场景不会被包装成成功；
- Evidence Record 标记所有未验证字段和平台限制。

当前不满足的条件：没有真实 API 请求、没有成功的 CLI/SDK 任务、没有 session 复用对照、没有 clean-diff 结果。执行规范完成不等于 Lab 通过。

## 影响正文

- `content/automation/headless-cli.md`
- `content/automation/python-sdk.md`
- `content/core/task-contract.md`
- `content/safety/permissions-and-data.md`
