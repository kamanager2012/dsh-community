# DeepSeek Harness Community Labs (DSH-Suite)

> Community Labs。不是下载入口。

**不要从本仓安装。** 正式发行在 [`dsh-community`](https://github.com/kamanager2012/dsh-community/releases/latest)。

[English](./README.md) | **简体中文**

[![Contract CI](https://github.com/kamanager2012/deepseek-harness-suite/actions/workflows/contract-ci.yml/badge.svg)](https://github.com/kamanager2012/deepseek-harness-suite/actions/workflows/contract-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![官方基准验证: 0.1.0-rc.6](https://img.shields.io/badge/Official%20DSH-0.1.0--rc.6%20verified-green.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh)

---

## 生态定位

本仓是 **Community Labs（社区实验舱）**，不是第二个用户产品，也不是下载入口。
Bridge、SDK transport、安全、Checkpoint、审计和实验性 TUI / Desktop 能力先在这里验证；
只有通过 Reality Gate、真实 E2E、安全和跨平台验证，才可以进入
[`dsh-community`](https://github.com/kamanager2012/dsh-community) 的 Canary、Preview 或 Stable。

| 仓库 | 定位 | 入口 |
|---|---|---|
| [`dsh-community`](https://github.com/kamanager2012/dsh-community) | Canonical Product，唯一正式下载入口 | [Latest](https://github.com/kamanager2012/dsh-community/releases/latest) · [current-release.json](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json) |
| [`deepseek-harness-handbook`](https://github.com/kamanager2012/deepseek-harness-handbook) | 知识、证据和运维手册 | [在线手册](https://kamanager2012.github.io/deepseek-harness-handbook/) |
| [`dsh-community-plugins`](https://github.com/kamanager2012/dsh-community-plugins) | 插件兼容性注册表 | [Registry](https://github.com/kamanager2012/dsh-community-plugins) |
| [`dsh-marketplace`](https://github.com/kamanager2012/dsh-marketplace) | 插件发现和安装体验 | [Marketplace](https://github.com/kamanager2012/dsh-marketplace) |
| [`dsh-community-edition`](https://github.com/kamanager2012/dsh-community-edition) | Merge & Archive，合流归档 | [历史参考](https://github.com/kamanager2012/dsh-community-edition) |

执行核心是官方 [DeepSeek Harness Runtime](https://github.com/deepseek-ai/deepseek-harness)。
Labs 不得重新实现 Agent loop、官方 Session persistence、Tool execution 或官方 core packages。

当前接手基线见 [docs/ECOSYSTEM_HANDOFF.md](docs/ECOSYSTEM_HANDOFF.md)，Reality Gate 证据见 [docs/reality-gate.md](docs/reality-gate.md)；
英文版见 [docs/ECOSYSTEM_HANDOFF.en.md](docs/ECOSYSTEM_HANDOFF.en.md)。

## 当前证据快照

| 门禁 | 状态 | 含义 |
|---|---|---|
| 代码 / 构建 / 单元 / 契约测试 | GREEN | 34/34 项测试通过，tsc -b 编译 0 错误。 |
| Reality Gate 防御与失败路径测试 | GREEN | Shell fail-closed、typed `SessionEvent.data` 解码、5MB 内存上限保护、祖先 Symlink 沙箱已完备覆盖。 |
| Upstream contract probe CI | GREEN | GitHub Actions CI 已绿（Run 31934271278，动态捕获 128 个官方插件）。 |
| Stdio JSON-RPC 协议流 E2E | GREEN | 禁用 fallback 条件下 `executionMode === sdk_jsonrpc` 硬断言与流式会话生命周期测试通过。 |
| 官方预装 Profile 实装验证 | `[PENDING_UPSTREAM]` | 等待 `@deepseek-ai/dsh` 官方发布包正式预装开箱即用的 stdio JSON-RPC profile。 |

## 🎯 架构设计与真实性声明（Reality Gate）

我们坚持 **“Official Source Ownership = 0”** 原则，绝不 Fork 或魔改官方仓库源码，将官方发布包 `@deepseek-ai/dsh` 作为独立外部运行时进行受控调度。

| 模块 / 能力 | 真实状态 | 事实与实现依据 |
| :--- | :--- | :--- |
| **官方零源码侵入** | `[REAL]` | 零魔改，直接通过 `npx @deepseek-ai/dsh@0.1.0-rc.6` 进程拉起驱动。 |
| **桌面受控浏览器壳** | `[REAL]` | Electron 宿主 + 官方 `dsh web` 本地进程 + 托盘常驻与生命周期管控。 |
| **跨平台进程树治理** | `[REAL]` | POSIX 独立进程组分离 + Windows 树杀（3080 端口 0 残留、0 僵尸进程）。 |
| **动态契约 CI 探针** | `[PROBE]` | 动态探针采集 128 个官方插件行与 CLI flags，并在离线时校验不可变快照。 |
| **终端极客视觉组件** | `[REAL]` | `DiffViewer`（行级红绿高亮）、`ReasoningBox`（R1 推理思维折叠）、`ToolCard`。 |
| **智能免审批引擎** | `[FAIL-CLOSED]` | `DshRiskEvaluator` 基于能力原语建模；未知/未识别工具一律 Fail-Closed 判定为高危并强行触发审批。 |
| **运行时调用通道** | `[LABS / SDK-ADAPTER]` | `DshRuntimeClient` 实装结构化 `SessionEvent.data` 解码与 Pre-enqueue 防重放；真实 JSON-RPC 运行环境待官方 Shipped Profile 验证。 |
| **交互式工具审批** | `[BLOCKED_BY_UPSTREAM]` | 客户端风控规则完备；官方 SDK 目前尚未开放服务端向客户端发起 Approval RPC 请求通道。 |
| **快照与工作区沙箱** | `[WORKSPACE-JAIL]` | `DshCheckpointEngine` 绑定工作区根目录，支持祖先 Symlink 越界穿透拦截、NUL/控制字符防护与 5MB 内存上限保护。 |
| **敏感与巨大目录防御** | `[REAL]` | `.dshignore` 引擎自动拦截 `.env`、密钥与 `node_modules` 避免被 AI 误读误改。 |
| **会话存储安全隔离** | `[READ-SAFE]` | 官方 `~/.dsh/sessions` 严格只读；Suite 自建状态安全隔离在 `~/.dsh/suite_sessions/`。 |
| **回滚与分叉** | `[UI-LEVEL]` | 标明当前为消息历史回退（`/rollback`），待官方 runtime 开放状态回滚 API。 |

## 🌟 产品架构：One Harness. Three Community Endpoints. (一套 Harness，三个社区端)

```text
                         Official DeepSeek Harness Runtime
                                       │
                      (共享 ~/.dsh 官方会话唯一真源)
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              │                              │
        ▼                              ▼                              ▼
  WSL / Linux 终端              Windows 桌面端                  macOS 桌面端
 (dsh-community CLI/TUI)     (DSH Community Setup.exe)       (DSH Community .dmg)
   (开发者 / Agent重度用户)      (下载 → 安装 → 配Key → 使用)     (下载 → 安装 → 配Key → 使用)
        │                              │                              │
        └──────────────────────────────┴──────────────────────────────┘
                                       │
                      统一正式发行版：dsh-community
```

* **官方 Web**：上游自带的基础交互界面，与三大社区端共享相同的 `~/.dsh` 会话存储。
* **Linux AppImage**：可选/次要构建产物（WSL/Linux 终端是 Linux 开发者最核心的主力端）。

---

## 本地开发（不是安装路径）

不要 `npx` / `npm i -g @dsh-community/tui`。那会走到公共 npm，且本仓不会把包发到 `latest`。

```bash
git clone https://github.com/kamanager2012/deepseek-harness-suite
cd deepseek-harness-suite
pnpm install
pnpm run build
pnpm --filter @dsh-community/tui start
```

用户安装走 [dsh-community/releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest)。

#### ⌨️ 常用终端指令表

* `/doctor` - 运行五层架构全身系统与环境体检（Node版本、API状态、端口、Token预算）
* `/plugins [关键词]` - 检索官方与社区插件注册表（`dsh-community-plugins`）
* `/audit` - 查看密码学 SHA-256 不可篡改的操作审计历史
* `/provider switch <id>` - 热切换模型服务商（`deepseek`、`siliconflow`、`volcengine`、`ollama`、`vllm`）
* `/undo` - 撤回上一步被 AI 修改或新建的文件快照
* `/export [markdown|json]` - 一键导出美观的 Markdown 或 JSON 会话报告
* `/sessions` - 浏览所有历史会话（包含官方会话与 Suite 会话）
* `/resume <id>` - 接续指定 ID 的会话
* `/save` - 原子保存当前会话
* `Esc` - 立即打断当前思考或生成

---

### 2. 桌面版

不要从本仓 Releases 下载（本仓不发安装包）。走
[dsh-community/releases/latest](https://github.com/kamanager2012/dsh-community/releases/latest)。

---

## 📖 实战指南与最佳实践 (Cookbook)

### 场景一：连接本地私有化 Ollama（100% 离线，零数据外流）
1. 启动本地 Ollama 实例并拉取 DeepSeek-R1：
   ```bash
   ollama run deepseek-r1:14b
   ```
2. 在 TUI 中直接切换到本地预设：
   ```text
   > /provider switch ollama deepseek-r1:14b
   ```

### 场景二：代码重构与安全防线
1. 执行 `/doctor` 确认工作区健康度；
2. 开启自动免审批模式，安全执行 `git status`、`ls`、`read_file` 零弹窗打扰；
3. 若 AI 提出的修改不符合预期，直接输入 `/undo`，秒级恢复受影响文件。

---

## 🩺 常见故障排查 (Troubleshooting)

| 症状 / 报错 | 原因分析 | 解决方案 |
| :--- | :--- | :--- |
| `端口 3080 被占用` | 此前第三方软件残留了官方 Node 孤儿进程 | Suite Desktop 启动时会自动避让并寻找新可用端口；或执行 `killall node`。 |
| `401 Unauthorized` | 环境变量未正确设置 API Key | 执行 `export DEEPSEEK_API_KEY="sk-..."` 或在启动时传入。 |
| `Context window > 90%` | 对话过长即将耗尽 128k 上下文 | 系统触发红色告警，推荐输入 `/fork` 创建新分支会话。 |
| `Protected path detected` | AI 尝试读取 `.env` 或私钥文件 | `.dshignore` 主动拦截，需用户明确审批后方可访问。 |

---

## 🛠️ 本地开发与契约测试

```bash
# 1. 安装依赖
pnpm install

# 2. 全量构建
pnpm run build

# 3. 运行单元与契约测试 (22 项全部通过)
pnpm run test

# 4. 运行上游真实动态探针
npx tsx scripts/contract-checker.ts
```

---

## 📄 开源协议
MIT © 2026 DeepSeek Harness Community Team
