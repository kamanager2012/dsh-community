# Labs

Lab 是文档的可执行证据和回归测试，不是装饰性示例。

## 生命周期

```text
planned
  → not_run
  → pass / fail / blocked
  → superseded（版本或实验设计被替换）
```

一个 Lab 只有在以下内容齐全后才能标为 `pass`：

- 固定版本、commit、平台和权限模式；
- 输入、workspace 隔离和清理方式；
- 完整命令或可复现操作；
- 预期结果和实际结果；
- 脱敏 Evidence Record；
- 失败条件、限制和受影响文档。

第一个 Lab 是 `LAB-BOOT-001`。它当前为 `not_run`；CLI/Web 启动前置证据见 `../evidence/records/CLI-BASELINE-2026-08-14.md`、`../evidence/records/WEB-BOOT-2026-08-14.md` 和 `../evidence/records/WEB-HTTP-2026-08-14.md`，初次环境阻塞作为历史记录保留在 `../evidence/records/CLI-PROBE-2026-08-14.yaml`。

自动化路径的第二个 P1 Lab 是 `LAB-AUTOMATION-001`，定义在 [`LAB-AUTOMATION-001/README.md`](LAB-AUTOMATION-001/README.md)，当前为 `planned`。

## 文档回归检查

每次新增或修改 Evidence、Lab、任务入口和相对链接后，运行：

```sh
python3 scripts/validate_handbook.py
```

检查器只读验证 Evidence 必填字段、来源矩阵引用、Lab 任务契约路径、Markdown 相对链接和敏感/私有路径模式。它不能替代 dsh 运行 Lab；模型、Provider、工具事件和 workspace 结果仍必须通过独立 Evidence Record 记录。
