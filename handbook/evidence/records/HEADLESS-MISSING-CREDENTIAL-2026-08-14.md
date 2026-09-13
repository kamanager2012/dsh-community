# HEADLESS-MISSING-CREDENTIAL-2026-08-14

这是固定发布包、临时 `DSH_HOME` 和 `read-only` 权限下的 headless 失败路径探针。

## 命令

```sh
DSH_HOME=/tmp/dsh-handbook-headless-missing-cred \
DSH_PERMISSION_MODE=read-only \
timeout 30s npx --yes @deepseek-ai/dsh@0.1.0-rc.6 \
  --profile headless "只回复已收到，不要读取或修改文件。"
```

## 观察结果

```text
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment
exit_code: 1
```

这证明失败路径返回了可供脚本识别的错误和非零状态。它不证明有凭据时的模型调用、任务输出、session 持久化或 workspace 行为。

对应 YAML 记录：[`HEADLESS-MISSING-CREDENTIAL-2026-08-14.yaml`](HEADLESS-MISSING-CREDENTIAL-2026-08-14.yaml)。
