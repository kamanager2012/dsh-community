# DSH-AIOS-MISSING-CREDENTIAL-2026-08-15

这是复制 handbook 后继续执行的 `LAB-BOOT-001` 无凭据启动前置。

## 隔离 workspace

- 来源 commit：`6af8968180eb9b14acd61c99d04253180d456303`；
- workspace：基于该 commit 创建的临时干净 checkout；
- `cc-switch.db`：不存在，未读取；
- 权限：`read-only`；
- dsh：`@deepseek-ai/dsh@0.1.0-rc.6`；
- Node：`v22.23.2`；
- 平台：Linux x64 / WSL2。

E 盘原始 `aios-core` checkout 当前包含用户改动，因此没有直接把它作为 Lab workspace，也没有清理或覆盖这些改动。

## 结果

固定版本及其依赖解析完成后，dsh 进入 headless profile，并在模型请求前返回：

```text
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
```

退出码为 `1`。探针之后临时 workspace 的 Git 状态仍为空，没有生成 `cc-switch.db`，也没有模型请求、AIOS 文件读取或工具任务结果。

## 解释

本记录是“凭据阻塞前置按预期停止”的 F2 通过，不是 AIOS 分析成功，也不改变 `LAB-BOOT-001` 的 `not_run` 状态。下一步只有在用户提供安全测试凭据并明确允许向 DeepSeek 发送该只读 workspace 内容后，才能执行 credentialed headless 任务；Web UI 交互仍另受浏览器工具链阻塞。

对应 YAML 记录：[`DSH-AIOS-MISSING-CREDENTIAL-2026-08-15.yaml`](DSH-AIOS-MISSING-CREDENTIAL-2026-08-15.yaml)。
