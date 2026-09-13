# LAB-SESSION-001：Session、Resume 与 Fork 行为

状态：`planned`（源码基线已建立；真实运行未开始）

## 目标

在同一个隔离 workspace 中，验证 dsh 的 Session 是否能区分历史读取、恢复、同 session 续跑和 fork。重点是持久状态、父子血统、事件边界和 workspace 安全，不评价模型文风或回答质量。

## 固定对象

| 对象 | 固定值 |
| --- | --- |
| dsh CLI | `@deepseek-ai/dsh@0.1.0-rc.6` |
| 官方源码 | `47f943859bef60e4160492346772ded9b24f765a` |
| workspace | `aios-core@6af8968` |
| 任务 | [AIOS 只读任务契约](../LAB-BOOT-001/aios-readonly-task.md) |
| 权限 | 从 `read-only` 开始 |
| 明确排除 | `cc-switch.db`、秘密文件、workspace 外路径 |

AIOS workspace 只能用于只读观察；不得把 Session Lab 变成修改 AIOS 的实验。基线见 [`AIOS-WORKSPACE-BASELINE-2026-08-14.yaml`](../../evidence/records/AIOS-WORKSPACE-BASELINE-2026-08-14.yaml)。

## 来源边界

固定源码记录了：Session 是仅追加事件日志；history 读取不恢复 Agent；Host fork 以已完成 turn 为边界创建新 session；header 带有 cwd、parent、seed 和 composition 相关元数据。[F1]

这些只构成实现事实，不代表当前 npm 包、Web UI 或 SDK 在本环境中已经通过。来源记录：[`SOURCE-SESSION-47F9438-2026-08-14.yaml`](../../evidence/records/SOURCE-SESSION-47F9438-2026-08-14.yaml)。

## 实验分组

| Run | 入口 | 动作 | 通过信号 |
| --- | --- | --- | --- |
| `S0` | Web/SDK/CLI 可用的最小入口 | 首次运行 AIOS 只读任务 | 获得 session ID、结束原因、事件摘要、clean diff |
| `S1` | Web 或 SDK | 重开/复用同一 session，提交低风险续跑提示 | ID 不被静默替换；事件追加到正确 session；workspace 仍 clean |
| `S2` | Web Host | 在已完成 turn 边界 fork | 新 child ID、parent ID、seed 前缀、父会话不变 |
| `S3` | Web/SDK | 在 fork 后分别追加不同只读提示 | parent 与 child 的事件链独立，workspace 均 clean |
| `S4` | 可控失败路径 | 缺凭据、不可用 session 或中断 | 错误分类清楚，不创建隐式成功 session |

`S2` 依赖暴露 fork 能力的入口。若某个入口没有公开 fork API，记录为“入口不支持/未暴露”，不要用内部 RPC 偷换成用户级支持。

## 任务输入

S0 使用 [LAB-BOOT-001 AIOS 只读任务契约](../LAB-BOOT-001/aios-readonly-task.md)的完整任务文本。

S1 只发送生命周期检查，不要求写入：

```text
继续当前 session 的只读分析。不要重新解释已经有文件依据的结论；只列出上一轮明确标记为“未验证”的项目，并说明你需要读取哪些 workspace 内文件才能验证它们。不要访问 cc-switch.db，不要修改、创建、删除文件，不要安装依赖或联网；如果当前 session 无法确认这些约束，立即停止。
```

S2 fork 后使用独立的只读变体：

```text
这是一个从已完成只读分析边界分出的新 session。只在当前 workspace 内复核一个指定的模块边界，列出文件依据和未验证项；不要修改文件、不要联网、不要访问 cc-switch.db。不要把 parent session 后续发生的内容当成你的历史。
```

这些文本是本手册独立设计的实验输入，不是外部文章示例，也不是 dsh 原生配置格式。

## 观察顺序

1. 记录初始 workspace 状态、session root 位置和权限模式；
2. 执行 S0，等待明确的 `turn/end` 或入口等价完成边界；
3. 记录 session ID、事件序号范围、cwd、模型/Provider 和 composition（若暴露）；
4. 执行 S1，检查是同一 session 追加还是出现新 session；
5. 在已完成 turn 的可复查边界执行 S2；
6. 对 parent 和 child 分别执行 S3，检查父子日志、标题/元数据和 workspace；
7. 执行 S4 或复用已有缺凭据前置失败，记录错误，不强行修复；
8. 清理临时 session root，不删除用户未授权的数据。

## 通过条件

### History / Resume

- history 读取没有触发模型请求或工具动作；
- resume/reopen 若入口支持，则恢复原 session identity 和必要 header；
- 续跑产生的新事件位于原日志之后；
- 不因恢复失败而静默创建一个新 session；
- workspace 没有新增 diff。

### Fork

- child session ID 与 parent 不同；
- parent lineage 可由脱敏 header/summary 复查；
- fork 边界落在已完成 turn，未裁剪打开的 turn；
- child 初始历史只覆盖约定 seed 前缀；
- parent 在 child 运行后不被改写；
- parent 和 child 后续事件可分别检索。

### 失败

- 缺凭据、未知 session、不可用 fork 边界、协议错误和超时分别分类；
- 失败不会被最终文本包装成成功；
- 不用“页面还能看到历史”掩盖运行时未恢复；
- 原始失败现场和 workspace 状态可复查。

## 证据登记

每个 Run 独立记录以下字段：

```yaml
run_id: "SESSION-<S0|S1|S2|S3|S4>-<date>"
layer: F2
status: "pass | fail | blocked | not_run"
entrypoint: "web | headless | python-sdk"
parent_session_ref: "sanitized or null"
child_session_ref: "sanitized or null"
workspace_ref: "sanitized fingerprint"
cwd_ref: "sanitized or omitted"
seed_boundary: "seq/turn summary or null"
event_range: "first..last or null"
finish_reason: "..."
model_ref: "provider/model or null"
workspace_diff: "empty | unexpected | not_checked"
limitations:
  - "..."
```

未运行字段必须保留为 `null` 或 `not_run`，不能用“推测应该如此”填充。

## 当前状态

Session 的 F1 源码事实已建立，实验卡已完成；Web 浏览器、模型凭据和真实 session 运行仍未就绪，因此 `S0–S4` 当前均未通过。
