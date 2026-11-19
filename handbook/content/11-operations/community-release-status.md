# Community 当前发行状态

> 事实快照日期：2026-11-19。机器可读真源是 [`dsh-community/docs/current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json)。本页只补充说明，不另造 Latest / 内核 pin。本文不替代 GitHub Release、Actions 结果或用户闭环实测。

## 版本模型

当前策略是社区产品 Candidate Source 1:1 镜像官方内核（仅在社区自有修补时附加 `-community.N`）。同时，`Candidate Source` 与 `Published Latest` 是两条独立状态。

| 层级 | 当前值 | 应如何理解 |
|---|---|---|
| Official core pin | `@deepseek-ai/dsh@0.2.2-rc.5` | 官方内核 |
| Candidate community product | `0.2.2-rc.5-community.1` | **已签署并发布为 GitHub Pre-release [`v0.2.2-rc.5-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.5-community.1)（12 资产齐全并通过 `artifact-smoke`，含 18 款精选插件目录与 Starter Pack）** |
| Historical Community Pre-release | [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1) | 2026-11-17 发布，已被 `v0.2.2-rc.5` 与 `v0.2.2-rc.5-community.1` 替代 |
| Published Latest | `v0.2.2-rc.5` | GitHub Latest；普通用户稳定主下载入口 |
| Historical tags | `v0.1.2`–`v0.1.6`, `v0.1.1-rc.2`, `v0.2.2-rc.2`, `v0.2.2-rc.2-community.1`, `v0.2.2-rc.3`, `v0.2.2-rc.3-community.1` | 已被 `v0.2.2-rc.5` 替代 |

Desktop 与 TUI 的版本身份必须同时显示 Dual-Badge：

```text
DeepSeek Harness Community v0.2.2-rc.5-community.1 [Official Core: @deepseek-ai/dsh@0.2.2-rc.5]
```
（Published Latest `v0.2.2-rc.5` 对应展示 `DeepSeek Harness Community v0.2.2-rc.5 [Official Core: @deepseek-ai/dsh@0.2.2-rc.5]`。）

## 用户选择

正式入口是 [`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest)。
普通用户下载 [`v0.2.2-rc.5`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.5)。

`v0.2.2-rc.5`（发布 Commit `0a8009d0462042764ad67e87208df791f1f6180b`）共上传 **12 个发行资产（3 个核心文件 + 3 个 `.sha256` 校验文件 + 6 个 keyless Cosign `.sigstore.json` 证明，不含 GitHub 自动源码归档**；Complementary Edition 发行 Linux AppImage + 已签名 Android `arm64-v8a` Remote Client APK + 官方运行时 CycloneDX SBOM，Windows Setup `.exe` 与 macOS `.dmg` 自历史 `v0.1.1-rc.2` 后退役并交还官方 `deepseek-ai/deepseek-harness`）：

- `dsh-community-0.2.2-rc.5.AppImage` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`
- `dsh-community-0.2.2-rc.5-android-arm64-v8a.apk` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`
- `dsh-community-0.2.2-rc.5-official-runtime.cdx.json` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`

三个互补社区端为 **WSL/Linux Terminal**（已发行）、**Linux AppImage**（已发行）与 **Android Remote Client**（已签名 `arm64-v8a` APK 已在 Latest 发行；CI `x86_64` 模拟器 E2EE 验收通过，物理真机遥测保持 `[UNVERIFIED]`）。官方 Web 与 Win/macOS Desktop 是上游端，共享 `~/.dsh`，不是社区端。

## Complementary Edition Release Gate

以下是本快照对应的最新观察结果：

| Gate | 状态 | 事实 |
|---|---|---|
| 普通 `dsh-community` CI | `[REAL]` | 主线 typecheck（8 projects）与全量 Vitest 在 `main` 通过；但普通 CI 不替代发行包验收 |
| Release assets & signing | `[REAL]` | `v0.2.2-rc.5` Latest（`releaseId=450856726`，`release` [Run 44453540672](https://github.com/kamanager2012/dsh-community/actions/runs/44453540672)）与 `v0.2.2-rc.5-community.1` Pre-release（`releaseId=451263403`，`release` [Run 44515930058](https://github.com/kamanager2012/dsh-community/actions/runs/44515930058)）均已发布 12 个带 SHA-256 与 keyless cosign bundle 的资产（历史 `v0.2.2-rc.3` / `v0.2.2-rc.3-community.1` 同规） |
| `artifact-smoke` | `[REAL]` | `v0.2.2-rc.5`（[Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621)）与 `v0.2.2-rc.5-community.1`（[Run 44516999116](https://github.com/kamanager2012/dsh-community/actions/runs/44516999116)）均已通过 `resolve`、`linux-appimage`、`android-apk`、`linux-terminal` 与 `verify-signatures`（cosign 12 文件全验）；前版 `v0.2.2-rc.3`（[Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193)）与 `v0.2.2-rc.3-community.1`（[Run 44005955539](https://github.com/kamanager2012/dsh-community/actions/runs/44005955539)）亦通过 |
| Full user loop | `[PARTIAL]` | [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) 通过 `.github/workflows/user-loop-evidence.yml` 对 `v0.2.2-rc.3` 完成社区 TUI ↔ 官方 `dsh --profile headless` ↔ Linux AppImage 内置运行时（`official-dsh.tar`）三方跨端 Session 接续、AppImage Electron GUI（`AppRun`）Session 可见性/Runtime/Marketplace 验证与全部 4 项生命周期恢复；针对 `v0.2.2-rc.5` 发布包的增量实盘闭环及物理 Android 真机闭环待后续按需触发 |

目标链路是：

```text
tag
  → release-identity + runtime-sbom + build-linux + build-android
  → cosign keyless sign
  → publish 12 signed assets to GitHub Release
```

## Stable 发布基线与历史 Pre-release

`v0.2.2-rc.5`（Commit `0a8009d0462042764ad67e87208df791f1f6180b`）现为当前 Published Latest（包含 `v0.2.2-rc.3-community.1` 的 `scripts/install-linux.sh`、无头 Chromium E2EE 验收、`observe` Git Diff 脱敏、Codex/ACP 崩溃恢复与 `#182` mDNS/配对/R6 修复，以及 `@deepseek-ai/dsh@0.2.2-rc.5` 内核升级）。

## Distribution Reality Gate

下表记录 exact-release-artifact 证据：

| 场景 | 状态 | 必须证明 |
|---|---|---|
| Linux AppImage + `dsh-community-0.2.2-rc.5.AppImage` | `[REAL]` | [Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621) 完成 `0.2.2-rc.5` SHA-256、解包与 keyless cosign 验签；前版 `rc.3` [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) 实证内置 `official-dsh.tar` 运行时及 Electron GUI（`AppRun`）能力 |
| WSL/Linux 终端 + `dsh-community` / `pnpm tui` | `[REAL]` | [Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621) 通过 `v0.2.2-rc.5` help、version、缺 key doctor、sessions、无 TTY 拒绝路径；前版 `rc.3` [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) 完成三方跨端 Session 接续 |
| Session 闭环 | `[PARTIAL]` | `v0.2.2-rc.3` 已通过 [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) 实证 `[REAL]`；通过官方 Web 或打包 Win·macOS / Linux Desktop 交互式界面直接续跑对话轮次仍为 `[待复核]` |
| Plugin / restart | `[PARTIAL]` | 18 个目录插件中 15 个已完成 `0.2.2-rc.5`（`dsh plugin add` + `--dump-config`）合成验证（含 6 款新手精选套装与 `dsh-tui@0.20.2`），其余 3 个旧插件仍为 `0.1.1-rc.2` |
| Lifecycle recovery | `[REAL]` | 缺少密钥干净拒绝（exit 2 / 0 孤儿会话）、`apps/desktop/src/host-extract.ts#ensureOfficialHostExtracted` Runtime 解压中断自愈恢复、版本升级与断网离线回退已通过 [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) 实证 `[REAL]` |
| Android Remote Client | `[PARTIAL]` | 已签名 `dsh-community-0.2.2-rc.5-android-arm64-v8a.apk` 在 Latest 发行并通过 [Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621) 验签，且 `0.2.2-rc.5` 已通过 [Run 44441973511](https://github.com/kamanager2012/dsh-community/actions/runs/44441973511) CI `x86_64` KVM 模拟器 E2EE 门禁；物理 `arm64-v8a` 真机遥测保持 `[UNVERIFIED]`（`REAL_DEVICE_ACCEPTANCE_READY = false`） |

结论必须来自 Release 页面真实下载的包与真实用户闭环记录；main 源码 smoke、普通 CI 或 README 声明不能代替。

## Runtime 版本来源差异

```text
Official kernel: @deepseek-ai/dsh@0.2.2-rc.5
Community product / Published Latest: v0.2.2-rc.5
Historical independent numbers: v0.1.2–v0.1.6 (not a user download)
```

参考：

- [`dsh-community` release workflow](https://github.com/kamanager2012/dsh-community/blob/main/.github/workflows/release.yml)
- [`dsh-community` changelog](https://github.com/kamanager2012/dsh-community/blob/main/CHANGELOG.md)
- [`dsh-community` contract snapshots](https://github.com/kamanager2012/dsh-community/tree/main/contracts)
- [`dsh-community` current-release.json](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json)
- 本仓 [`archive/deepseek-harness-suite/`](https://github.com/kamanager2012/dsh-community/tree/main/archive/deepseek-harness-suite)（已归档 Labs，不要安装）

> **最新社区预发布（Pre-release）**：[`v0.2.2-rc.5-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.5-community.1)（基于官方 `@deepseek-ai/dsh@0.2.2-rc.5`，含 18 款精选插件目录、Desktop 新手精选套装与 `dsh-marketplace starter`）已通过 `release.yml`（[Run 44515930058](https://github.com/kamanager2012/dsh-community/actions/runs/44515930058)）与 `artifact-smoke`（[Run 44516999116](https://github.com/kamanager2012/dsh-community/actions/runs/44516999116)）12 资产签发与校验；GitHub Published Latest 保持为 [`v0.2.2-rc.5`](https://github.com/kamanager2012/dsh-community/releases/latest)。
