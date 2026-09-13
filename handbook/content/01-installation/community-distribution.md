# DSH 社区发行版（dsh-community）

> 本页描述 **DSH Community** —— 官方 DeepSeek Harness Runtime 之上的社区发行版。
> 版本号、安装包名称与校验和一律以 [GitHub Release 页面](https://github.com/kamanager2012/dsh-community/releases) 为准，不以此页为准。

## 定位：Community Distribution，不是 Desktop 壳

**One Harness. Five Community Endpoints.**

```text
             Official DeepSeek Harness Runtime
                         │
     ┌──────────┬────────┼────────┬──────────┐
     ▼          ▼        ▼        ▼          ▼
 WSL/Linux   Windows   macOS   Linux      Android
  Terminal   Desktop   Desktop AppImage    (archived Labs)
```

- 社区层**不重写** Agent loop、Session persistence、Tool execution —— 官方 Runtime 是唯一执行核心。
- 社区层**不 patch** 官方 UI 表面；升级 = 契约重验，不是重写补丁。
- 官方 Web 是内核自带界面：它和社区端共用同一套 `~/.dsh` Session，但它不是社区发行端。

五个社区端：

| 端 | 面向 | 入口 |
|---|---|---|
| WSL / Linux Terminal | 开发者、CLI 用户、WSL2 用户 | `dsh-community` 命令 |
| Windows Desktop | 不想折腾 Node / CLI 的用户 | `DSH.Community.Setup.0.1.1-rc.2.exe`（以 Release 页为准） |
| macOS Desktop | 同上 | `dsh-community-0.1.1-rc.2.dmg` |
| Linux AppImage | Linux 图形桌面 | `dsh-community-0.1.1-rc.2.AppImage` |
| Android | 已归档 Labs | 不在 Latest 下载页，`[UNVERIFIED]` |

## 下载与校验

```text
https://github.com/kamanager2012/dsh-community/releases/latest
```

- **Latest** 指向 `releases/latest`；当前是 **v0.1.1-rc.2**（Linux AppImage / Windows Setup / macOS dmg）。历史独立编号 `v0.1.2`–`v0.1.6` 不是当前下载。
- 每个资产带 `<文件>.sha256` 侧车；安装前用 `sha256sum` / `certutil` / `shasum -a 256` 核对。

## 同一套 Session：Web ↔ Terminal ↔ Desktop

社区端默认共用官方 `~/.dsh`：

```text
官方 Web 里开的对话
      ↓
关掉 Web，用 dsh-community 终端 resume
      ↓
再打开 Desktop，还是同一条会话
```

社区层不另建第二套 session 存储；隔离模式（`DSH_COMMUNITY_ISOLATED=1`）是显式选择的例外。

## 社区终端（WSL / Linux）常用命令

```bash
dsh-community                  # 有对话就接着最近一条，否则开新的
dsh-community new              # 强制开新对话
dsh-community resume last      # 接着最近一条
dsh-community sessions         # 列出官方 ~/.dsh 里的对话（--porcelain 机器可读）
dsh-community doctor           # 自检：官方包 / TTY / 密钥（不打印密钥）
dsh-community plugins          # 只读插件目录
dsh-community desktop          # 打开桌面壳
```

需要 Node 22+、pnpm、`DEEPSEEK_API_KEY`；没密钥不会闷头进 Ink，`doctor` 会明确提示。

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

发布不等于可用。每个 Release 的**真实安装包**要在干净机器上过一轮：

```text
干净 VM → 下载 Release 资产 → sha256 核对 → 安装 → 首启
→ 官方 Runtime 就绪 → 缺 key / 断网失败路径 → 退出无残留
```

- 自动门禁：`artifact-smoke` 工作流（Windows / macOS runner 上下载 exact release 资产实测）。
- 状态标注规则：只允许 `[REAL] / [PARTIAL] / [UNVERIFIED] / [NOT_IMPLEMENTED]` 等明确标签，禁止 production-ready 一类说法。
- 2026-08-21 记录：`v0.1.1-rc.1` 三资产在 [Run 32489762676](https://github.com/kamanager2012/dsh-community/actions/runs/32489762676) 通过安装/首启或缺 key smoke；完整用户闭环仍未验证。历史记录：v0.1.4 曾因桌面解压缺依赖回退 Latest。**桌面安装包的完整用户流状态以 artifact-smoke 最新 run 为准。**

## 相关仓库

| 仓库 | 角色 |
|---|---|
| [dsh-community](https://github.com/kamanager2012/dsh-community) | Canonical Product，唯一正式下载入口 |
| [dsh-community marketplace](https://github.com/kamanager2012/dsh-community/tree/main/packages/marketplace) | 插件发现、安装 UX 与 `catalog.json` |
| 本仓 [archive/deepseek-harness-suite](https://github.com/kamanager2012/dsh-community/tree/main/archive/deepseek-harness-suite) | 已归档 Labs（原独立仓已并入；不要安装） |
| 本仓 `handbook/`（原独立手册仓已并入） | 本手册 |
