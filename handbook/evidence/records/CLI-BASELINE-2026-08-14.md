# CLI-BASELINE-2026-08-14

这是固定发布包 `@deepseek-ai/dsh@0.1.0-rc.6` 的 F2 前置探针。运行时为 Node `v24.18.0`、Linux x64 / WSL2；探针只读取版本、帮助和组合配置，不配置 Provider、不发起模型请求、不操作 workspace。

## 命令与结果

```text
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 --version       output 0.1.0-rc.6, exit 0
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 --help       exit 0
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web --help  exit 0
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 headless --help  launcher help, exit 0
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 --profile headless --help  headless app help, exit 0
DSH_HOME=/tmp/dsh-handbook-probe-rc6 npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web --dump-default-config  exit 0
```

## 关键观察

启动器帮助包含 `--profile`、`--patch`、`--dump-config`、`--dump-default-config`，以及 `web` 和 `plugin` 命令；示例中明确出现 `headless`、`tui --resume` 和 `web` profile。

Web 帮助包含：

```text
--host <host>
--port <port>                  listen port; pass 0 to let the OS pick a free one
--trusted-host <authority...>
```

显式的 headless profile 帮助包含 `task` 位置参数，说明任务文本由 profile 应用接收；这只是参数边界探针，不是一次真实任务运行。

默认配置导出的可复核片段包括：

- `agent-default-model`: provider `deepseek-official`，model `deepseek-v4-flash`；
- telemetry mode 读取 `DSH_TELEMETRY_MODE`，默认 `DISABLED`；默认 exporter URL 为 `https://harness-telemetry.deepseeksvc.com/v1/logs`；
- sandbox policy mode 读取 `DSH_PERMISSION_MODE`，默认 `workspace-write`，workspace root 为 `process.cwd()`；
- approval policy 在 `danger-full-access` 之外默认为 `ask`；
- permission presets 包含 `read-only`、`workspace-write`、`danger-full-access`；
- Web profile 中可见 workspace、session projection、trajectory、model settings 与 Web startup/runtime 组件，同时有多项交互工具在默认 Web patch 中被禁用。

完整的默认配置没有原样存入仓库，以避免把版本内部组合误当成稳定 API；正式章节只引用本记录并标注 F1/F2 边界。

对应 YAML 记录：[`CLI-BASELINE-2026-08-14.yaml`](CLI-BASELINE-2026-08-14.yaml)。
