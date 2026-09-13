# Headless CLI：把一次任务放进脚本

Headless 适合“给一个任务、等待它结束、拿到输出和退出码”的自动化场景。它不是 Web UI 的无头浏览器，而是一个直接运行 Agent 任务的 CLI profile。参数说明见[官方 CLI 中文参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.zh.md)。

## 基本调用

```bash
npx @deepseek-ai/dsh --profile headless "检查当前仓库的测试入口，只报告结果，不修改文件。"
```

启动器参数放在任务文本之前，任务文本是位置参数。任务来自 Issue、网页或用户提交内容时，先把它当作不可信输入处理，不要未经审查地赋予写入权限。

需要确认当前版本支持的参数时：

```bash
npx @deepseek-ai/dsh --help
npx @deepseek-ai/dsh --profile headless --help
```

## 退出码和完成定义

Headless 会创建一次 Agent 运行，等待任务结束并输出最终结果。任务正常完成时退出码为 0；其他结束原因返回非零退出码。脚本不能只检查 stdout 是否非空，还要结合：

- 进程退出码；
- 最终输出；
- 任务使用的工作区；
- 实际文件 diff；
- 独立测试或验收命令。

推荐的外部流程是：

```text
准备隔离 workspace
  → 提交包含范围和验收标准的任务
  → 采集 stdout、stderr 和退出码
  → 运行独立验收器
  → 检查 diff 和产物
  → 根据结果决定交付、重试或人工介入
```

Agent 的最后一句话不是验收器。

## 只读任务模板

```text
目标：检查项目的测试入口和当前失败项。
范围：只读当前 workspace。
禁止：修改文件、安装依赖、访问 workspace 之外的路径、联网搜索。
输出：列出实际检查过的文件和命令；区分观察、推断和不确定项。
失败：权限不足、测试命令失败或环境不完整时返回非成功状态并说明原因。
```

任务允许修改时，使用干净 checkout 或临时分支，并把以下内容写进任务：

- 允许修改的目录；
- 禁止操作；
- 测试、构建和格式检查命令；
- 失败时的停止条件；
- 回滚或清理方式。

## 参数位置

Web 和 headless 的参数不要混用。例如：

```bash
npx @deepseek-ai/dsh --profile web --port 3080
npx @deepseek-ai/dsh --profile headless "运行只读检查并报告结果。"
```

需要处理复杂任务文本时，先把任务放入受控文件或由脚本安全传入，避免 shell 转义改变原意。不要把密钥放进命令行参数。

## 自动化安全

- 在临时 checkout、容器或其他可恢复环境中运行；
- 通过环境或凭据管理器提供密钥，不写入任务文本；
- 让外部验收器独立检查退出码、diff 和测试；
- 不自动重试不可逆操作；
- 并发运行前先明确预算、超时、重试和人工介入策略；
- 保存日志前脱敏 token、Cookie、Authorization header、私有路径和用户输入。

如果凭据缺失、权限不足、工作区不对或验收失败，保留错误信息并停止流水线，不要把“进程启动成功”当作“任务完成”。

## 版本提示

Headless 的参数和 profile 可能随版本变化。升级后重新查看 `--help`，并在实际工作区执行一次低风险任务，再接入 CI。
