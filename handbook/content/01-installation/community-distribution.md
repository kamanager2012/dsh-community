# DSH 社区发行版（dsh-community）

> 本页描述 **DSH Community** —— 官方 DeepSeek Harness Runtime 之上的互补社区发行版。
> 版本号、安装包名称与校验和一律以 [GitHub Release 页面](https://github.com/kamanager2012/dsh-community/releases) 与 [`docs/current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json) 为准。

## 定位：Complementary Edition，不是第二套内核

**One Harness. Three Complementary Community Endpoints.**

```text
             Official DeepSeek Harness Runtime
       （官方 Web + Win/macOS Desktop 归上游维护）
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
      WSL/Linux        Linux         Android
      Terminal       AppImage    Remote Client [UNVERIFIED]
```

- 社区层**不重写** Agent loop、Session persistence、Tool execution —— 官方 Runtime 是唯一执行核心。
- 社区层**不 patch** 官方 UI 表面；升级 = 契约重验，不是重写补丁。
- 官方 Web 与 Windows / macOS Desktop 归官方上游（`deepseek-ai/deepseek-harness`）所有；历史版本 `v0.1.1-rc.2` 之后社区不再双份构建 Win/macOS 安装包。

三个互补社区端（全部已发行；Android 物理真机遥测保持 `[UNVERIFIED]`）：

| 端 | 面向 | 入口 |
|---|---|---|
| WSL / Linux Terminal | 开发者、CLI 用户、WSL2 用户 | `dsh-community` 命令（`pnpm start` / `pnpm tui`） |
| Linux AppImage | Linux 图形桌面 | `dsh-community-0.2.2-rc.3.AppImage`（以 Release 页为准） |
| Android Remote Client | 轻量移动远程客户端 | `dsh-community-0.2.2-rc.3-android-arm64-v8a.apk`（以 Release 页为准；CI `x86_64` 模拟器 E2EE 已验收，物理真机遥测 `[UNVERIFIED]`） |

## 下载与校验

```text
https://github.com/kamanager2012/dsh-community/releases/latest
```

- **Latest** 指向 `releases/latest`；当前为 **v0.2.2-rc.3**（Linux AppImage + 已签名 Android `arm64-v8a` APK + 官方运行时 CycloneDX SBOM，共 12 个带签名文件；历史 `v0.1.2`–`v0.1.6` 与 `v0.1.1-rc.2` 均不是当前下载）。
- 每个资产同时附带 `.sha256` 摘要侧车与 `.sigstore.json` keyless cosign bundle；安装前务必使用 `sha256sum -c` 与 `cosign verify-blob --bundle` 核对。

## 同一套 Session：官方 Web / Win·macOS ↔ Terminal ↔ Linux AppImage

社区端默认共用官方 `~/.dsh`：

```text
官方 Web 或官方 Win/macOS Desktop 里开的对话
      ↓
用 WSL/Linux dsh-community 终端 resume
      ↓
再打开 Linux AppImage，还是同一条会话
```

社区层不另建第二套 session 存储；隔离模式（`DSH_COMMUNITY_ISOLATED=1`）是显式选择的例外。如需跨设备或配合 Claude Code / Codex CLI / OpenCode 使用端到端加密控制面，可启动 `dsh-community remote start --qr`。

## 社区终端（WSL / Linux）常用命令

```bash
dsh-community                  # 有对话就接着最近一条，否则开新的
dsh-community new              # 强制开新对话
dsh-community resume last      # 接着最近一条
dsh-community sessions         # 列出官方 ~/.dsh 里的对话（--porcelain 机器可读）
dsh-community doctor           # 自检：官方包 / TTY / 密钥（不打印密钥）
dsh-community plugins          # 只读插件目录
dsh-community desktop          # 打开桌面壳
dsh-community remote start --qr # 启动 E2EE 多 Agent 远程控制面
```

需要 Node.js 24.9+（官方包声明 `engines.node >=24.9.0`；本仓工作区最低 22.15）、pnpm、`DEEPSEEK_API_KEY`（DSH 模式）或本地对应 Agent CLI；没密钥不会闷头进 Ink，`doctor` 会明确提示。

## 插件：验证层，不是最大目录

[`dsh-community/packages/marketplace/catalog.json`](https://github.com/kamanager2012/dsh-community/blob/main/packages/marketplace/catalog.json) 是**兼容性目录**，
不跟 awesome 目录比收录数量。每个条目携带验证证据：

| 层级 | 检查 | 方式 |
|---|---|---|
| existence | npm 上存在且版本一致 | CI（`scripts/verify.mjs`） |
| package digest | npm `dist.integrity` 与目录记录一致 | CI |
| provenance | npm 发布证明存在时记入目录 | CI |
| repo | 公开仓库可达 | CI |
| install / compose | 官方 `dsh plugin add` + `--dump-config` 合成断言 | CI（`scripts/compose-check.mjs`） |
| runtime smoke | 真实会话运行冒烟 | 人工，证据写入 `notes` |

浏览与安装：

```bash
dsh-marketplace list
dsh-marketplace info <name>
dsh-marketplace install <name>
```

`info` 会展示 digest 与 provenance；`install` 打印注册表 digest 与 `npm view … dist.integrity` 核对命令。安装本身走官方 `dsh plugin add`。

## 发布与验证（Distribution Reality Gate）

发布不等于可用。每个 Release 的**真实安装包**要在干净环境过一轮：

```text
干净 runner → 下载 Release 资产 → cosign & sha256 核对 → 解包/启动
→ 官方 Runtime 就绪 → 缺 key / 无 TTY 失败路径 → 退出无残留
```

- 自动门禁：`artifact-smoke` 工作流（下载 exact release `.AppImage`、Android `.apk` + sidecars 校验并跑 Linux AppImage、Android APK 与 TUI smoke）。
- 状态标注规则：只允许 `[REAL] / [PARTIAL] / [UNVERIFIED] / [NOT_IMPLEMENTED]` 等明确标签，禁止 `production-ready` 一类说法。
- 2026-11-15 记录：`v0.2.2-rc.3` 真实资产在 [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) 通过 `resolve`、`linux-appimage`、`android-apk`、`linux-terminal` 与 `verify-signatures`（cosign keyless 12 文件全通过）；社区 TUI ↔ 官方 `dsh --profile headless` ↔ Linux AppImage 内置运行时（`official-dsh.tar`）三方跨端 Session 接续、Linux AppImage Electron GUI（`AppRun`）Session 可见性/Runtime/Marketplace 离线缓存验证，以及缺 Key 干净拒绝、`ensureOfficialHostExtracted()` 解压中断恢复、版本升级与断网离线回退全部 4 项生命周期恢复，均已通过 [`user-loop-evidence.yml`](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) 验收 `[REAL]`（通过交互式官方 Web / Win·macOS 桌面发对话轮次尚未纳入自动化实测），物理 `arm64-v8a` Android 真机遥测仍为 `[UNVERIFIED]`。
- 2026-11-17 记录：Candidate Pre-release [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1)（不覆盖 `v0.2.2-rc.3` Latest）通过 `release` [Run 44004421253](https://github.com/kamanager2012/dsh-community/actions/runs/44004421253) 发布 12 个签名资产，并在 `artifact-smoke` [Run 44005955539](https://github.com/kamanager2012/dsh-community/actions/runs/44005955539) 全量通过 `resolve`、`linux-appimage`、`android-apk`、`linux-terminal` 与 `verify-signatures`。

## 相关仓库

| 仓库 | 角色 |
|---|---|
| [dsh-community](https://github.com/kamanager2012/dsh-community) | Canonical Product，唯一正式下载入口 |
| [dsh-community marketplace](https://github.com/kamanager2012/dsh-community/tree/main/packages/marketplace) | 插件发现、安装 UX 与 `catalog.json` |
| 本仓 [archive/deepseek-harness-suite](https://github.com/kamanager2012/dsh-community/tree/main/archive/deepseek-harness-suite) | 已归档 Labs（原独立仓已并入；不要安装） |
| 本仓 `handbook/`（原独立手册仓已并入） | 本手册 |
