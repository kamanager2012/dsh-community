# Community 当前发行状态

> 事实快照日期：2026-11-15。机器可读真源是 [`dsh-community/docs/current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json)。本页只补充说明，不另造 Latest / 内核 pin。本文不替代 GitHub Release、Actions 结果或用户闭环实测。

## 版本模型

当前策略是社区产品 Candidate Source 1:1 镜像官方内核（仅在社区自有修补时附加 `-community.N`）。同时，`Candidate Source` 与 `Published Latest` 是两条独立状态。

| 层级 | 当前值 | 应如何理解 |
|---|---|---|
| Official core pin | `@deepseek-ai/dsh@0.2.2-rc.3` | 官方内核 |
| Candidate community product | `0.2.2-rc.3` | 与官方内核 1:1 同号 |
| Published Latest | `v0.2.2-rc.3` | GitHub Latest；普通用户只从这里下 |
| Historical tags | `v0.1.2`–`v0.1.6`, `v0.1.1-rc.2`, `v0.2.2-rc.2`, `v0.2.2-rc.2-community.1` | 已被 `v0.2.2-rc.3` 替代 |

Desktop 与 TUI 的版本身份必须同时显示 Dual-Badge：

```text
DeepSeek Harness Community v0.2.2-rc.3 [Official Core: @deepseek-ai/dsh@0.2.2-rc.3]
```

## 用户选择

正式入口是 [`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest)。
普通用户下载 [`v0.2.2-rc.3`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3)。

`v0.2.2-rc.3` 已发布资产共 **12 个已签名文件**（Complementary Edition 发行 Linux AppImage + 已签名 Android `arm64-v8a` Remote Client APK + 官方运行时 CycloneDX SBOM；Windows Setup `.exe` 与 macOS `.dmg` 自历史 `v0.1.1-rc.2` 后退役并交还官方 `deepseek-ai/deepseek-harness`）：

- `dsh-community-0.2.2-rc.3.AppImage` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`
- `dsh-community-0.2.2-rc.3-android-arm64-v8a.apk` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`
- `dsh-community-0.2.2-rc.3-official-runtime.cdx.json` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`

三个互补社区端为 **WSL/Linux Terminal**（已发行）、**Linux AppImage**（已发行）与 **Android Remote Client**（已签名 `arm64-v8a` APK 已在 Latest 发行；CI `x86_64` 模拟器 E2EE 验收通过，物理真机遥测保持 `[UNVERIFIED]`）。官方 Web 与 Win/macOS Desktop 是上游端，共享 `~/.dsh`，不是社区端。

## Complementary Edition Release Gate

以下是本快照对应的最新观察结果：

| Gate | 状态 | 事实 |
|---|---|---|
| 普通 `dsh-community` CI | `[REAL]` | 主线 typecheck（8 projects）与全量 Vitest 在 `main` 通过；但普通 CI 不替代发行包验收 |
| Release assets & signing | `[REAL]` | `v0.2.2-rc.3`（`releaseId=445732060`）发布 12 个带 SHA-256 与 keyless cosign bundle 的资产 |
| `artifact-smoke` | `[REAL]` | [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) 通过 `resolve`、`linux-appimage`、`android-apk`、`linux-terminal` 与 `verify-signatures`（cosign 12 文件全验） |
| Full user loop | `[PARTIAL]` | [Run 43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931) 通过 `.github/workflows/user-loop-evidence.yml` WSL/Linux 终端真实模型新建与恢复会话验收；跨端桌面接续仍待复核 |

目标链路是：

```text
tag
  → release-identity + runtime-sbom + build-linux + build-android
  → cosign keyless sign
  → publish 12 signed assets to GitHub Release
```

## Stable 发布基线与当前 main

`v0.2.2-rc.3` 是当前 Published Latest。`main` 上可以有发布后的文档、控制面或验证修复，那些提交不自动等于已发布安装包内容。

## Distribution Reality Gate

下表记录 exact-release-artifact 证据：

| 场景 | 状态 | 必须证明 |
|---|---|---|
| Linux AppImage + `dsh-community-0.2.2-rc.3.AppImage` | `[REAL]` | [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) 完成 SHA-256、解包、headless 检查与 keyless cosign 验签 |
| WSL/Linux 终端 + `dsh-community` / `pnpm tui` | `[REAL]` | 同一 run 通过 help、version、缺 key doctor、sessions、无 TTY 拒绝路径；[Run 43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931) 完成真实模型 `new -> answer -> resume -> answer` |
| Session 闭环 | `[PARTIAL]` | WSL/Linux 终端内新建与恢复已通过 [Run 43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931) 验收；官方 Web / 官方 Win·macOS Desktop ↔ WSL/Linux TUI ↔ Linux AppImage 跨端接续仍为 `[待复核]` |
| Plugin / restart | `[PARTIAL]` | 9 个目录插件中 6 个已完成 `0.2.2-rc.3`（`dsh plugin add` + `--dump-config`）合成验证；其余 3 个旧插件仍为 `0.1.1-rc.2` |
| Lifecycle recovery | `[待复核]` | 升级、断网、缺少密钥、Runtime 解压中断后的恢复行为 |
| Android Remote Client | `[PARTIAL]` | 已签名 `dsh-community-0.2.2-rc.3-android-arm64-v8a.apk` 在 Latest 发行并通过 [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) 验签及 CI `x86_64` 模拟器 E2EE 门禁；物理 `arm64-v8a` 真机遥测保持 `[UNVERIFIED]`（`REAL_DEVICE_ACCEPTANCE_READY = false`） |

结论必须来自 Release 页面真实下载的包与真实用户闭环记录；main 源码 smoke、普通 CI 或 README 声明不能代替。

## Runtime 版本来源差异

```text
Official kernel: @deepseek-ai/dsh@0.2.2-rc.3
Community product / Published Latest: v0.2.2-rc.3
Historical independent numbers: v0.1.2–v0.1.6 (not a user download)
```

参考：

- [`dsh-community` release workflow](https://github.com/kamanager2012/dsh-community/blob/main/.github/workflows/release.yml)
- [`dsh-community` changelog](https://github.com/kamanager2012/dsh-community/blob/main/CHANGELOG.md)
- [`dsh-community` contract snapshots](https://github.com/kamanager2012/dsh-community/tree/main/contracts)
- [`dsh-community` current-release.json](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json)
- 本仓 [`archive/deepseek-harness-suite/`](https://github.com/kamanager2012/dsh-community/tree/main/archive/deepseek-harness-suite)（已归档 Labs，不要安装）
