# DSH-AIOS-MISSING-CREDENTIAL-2026-08-14

这是把用户指定的 `aios-core` 作为 dsh workspace 后执行的 read-only headless 预检。

## Workspace 基线

- 仓库 commit：`6af8968180eb9b14acd61c99d04253180d456303`；
- AIOS 自身 `npm run check`：27 个测试文件、265 个测试通过；
- 预先存在的未跟踪 `cc-switch.db` 被排除，没有打开或修改；
- dsh 权限：`read-only`；
- dsh 发布包：`@deepseek-ai/dsh@0.1.0-rc.6`。

## dsh 命令

```sh
DSH_HOME=/tmp/dsh-handbook-aios-missing-cred \
DSH_PERMISSION_MODE=read-only \
timeout 30s npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  --profile headless \
  "只读检查这个 AIOS Core 项目的模块边界和测试入口，不要读取或修改 cc-switch.db，不要修改任何文件。"
```

## 观察结果

```text
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
exit_code: 1
```

因此当前只证明：dsh 能以指定工作目录进入 headless 启动路径，并在缺少凭据时明确阻塞；没有证明 dsh 已经读取、理解或修改 AIOS。

对应 YAML 记录：[`DSH-AIOS-MISSING-CREDENTIAL-2026-08-14.yaml`](DSH-AIOS-MISSING-CREDENTIAL-2026-08-14.yaml)。
