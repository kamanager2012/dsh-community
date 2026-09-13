# LAB-BOOT-001：Web UI first boot and read-only task

状态：`not_run`

## 目标

在固定版本下启动 dsh Web UI，配置模型，选择隔离 workspace，运行一次只读仓库概览，并证明工作区没有产生 diff。

## 官方入口

- [官方 Web UI 中文指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.zh.md)
- [官方 CLI 中文参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.zh.md)

## 前置条件

- 使用 `VERSION.md` 中锁定的 dsh、Node、平台和 commit；
- 使用可丢弃或已提交干净变更的 workspace；
- 凭据从本地环境或凭据管理器注入，不写入命令历史、日志或仓库；
- 先使用只读或最小权限策略；
- 当前 Lab 不验证真实模型质量，只验证启动、配置、workspace、工具事件和无 diff 结果。

### 当前测试 workspace

本轮使用用户指定的 `aios-core` 作为真实 workspace：

- commit：`6af8968180eb9b14acd61c99d04253180d456303`；
- 项目自身 `npm run check` 已通过 27 个测试文件、265 个测试；
- 已存在的未跟踪 `cc-switch.db` 被明确排除，不打开、不修改；
- dsh read-only 预检已记录，但因缺少 `DEEPSEEK_API_KEY` 在模型请求前停止。
- Web 服务已能启动并返回 HTTP，但浏览器探针因环境没有可用 Chromium 被阻塞。
- 2026-08-15 重新验证了 Web profile：随机本机端口启动成功，根路径返回
  HTTP 200 和 DeepSeek Harness HTML shell；浏览器交互仍未运行。
- 2026-08-15 继续执行时，从该 commit 创建了干净的临时 checkout；无凭据
  headless 预检再次在模型请求前返回 `MISSING_CREDENTIAL`。E 盘原始
  `aios-core` 当前有用户改动，因此没有被清理、覆盖或用于本次 Lab。

证据：[`AIOS-WORKSPACE-BASELINE-2026-08-14.yaml`](../../evidence/records/AIOS-WORKSPACE-BASELINE-2026-08-14.yaml)、[`DSH-AIOS-MISSING-CREDENTIAL-2026-08-14.md`](../../evidence/records/DSH-AIOS-MISSING-CREDENTIAL-2026-08-14.md)、[`DSH-AIOS-MISSING-CREDENTIAL-2026-08-15.md`](../../evidence/records/DSH-AIOS-MISSING-CREDENTIAL-2026-08-15.md)、[`WEB-BOOT-2026-08-15.md`](../../evidence/records/WEB-BOOT-2026-08-15.md)、[`WEB-HTTP-2026-08-15.md`](../../evidence/records/WEB-HTTP-2026-08-15.md)、[`DSH-AIOS-WEB-BROWSER-BLOCKED-2026-08-14.md`](../../evidence/records/DSH-AIOS-WEB-BROWSER-BLOCKED-2026-08-14.md)。

本 workspace 的具体只读任务契约见 [`aios-readonly-task.md`](aios-readonly-task.md)。它要求 Agent 用文件依据交叉检查 README、形式化 SPEC、源码和测试，并保留它们之间的差异；该任务契约已准备好，但尚未完成 dsh 模型路径。

静态参考差异见 [`AIOS-READONLY-REFERENCE-2026-08-14.yaml`](../../evidence/records/AIOS-READONLY-REFERENCE-2026-08-14.yaml)。

## 执行草案

```sh
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 --help
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web --help
npx --yes @deepseek-ai/dsh@0.1.0-rc.6 web --port 0
```

然后：

1. 打开本地 Web UI；
2. 在 Settings → Models 配置模型；
3. 选择隔离 workspace；
4. 发送只读任务，例如总结仓库结构和主要包；
5. 检查 Trajectory 或 Session 证据；
6. 检查工作区 diff 为空；
7. 停止服务并记录清理结果。

## 通过条件

- 版本、平台、workspace 指纹和权限模式已记录；
- Web UI 启动成功；
- 模型请求成功且没有把凭据写入证据；
- Agent 只读完成任务；
- 工具事件和最终结果可定位；
- 工作区没有未预期的文件修改；
- Evidence Record 已登记限制和受影响章节。

## 当前状态

CLI 帮助、Web 帮助、默认配置导出和随机端口 Web 启动公告已经通过固定版本探针，记录在：

- `evidence/records/CLI-BASELINE-2026-08-14.md`；
- `evidence/records/WEB-BOOT-2026-08-14.md`；
- `evidence/records/WEB-HTTP-2026-08-14.md`。

这些结果只证明 CLI/Web profile 的启动前置条件和 HTTP 根路径可达，不证明端到端 Lab 已通过。当前仍未运行浏览器交互、Provider 配置、真实模型请求、workspace 只读任务、Trajectory/session 取证或 clean diff 检查，因此状态保持 `not_run`。初次 npm 无输出的环境记录见 `CLI-PROBE-2026-08-14.yaml`，已不再作为当前阻塞。

AIOS 只读任务契约已经就绪；凭据和浏览器阻塞解除后，优先按该契约执行 headless，再复核 Web UI。不要把 `MISSING_CREDENTIAL` 预检、HTTP `200` 或项目自身测试通过误写成 dsh 已完成 AIOS 分析。
