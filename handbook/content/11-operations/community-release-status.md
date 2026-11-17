# Community 当前发行状态

> 事实快照日期：2026-11-17。机器可读真源是 [`dsh-community/docs/current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json)。本页只补充说明，不另造 Latest / 内核 pin。本文不替代 GitHub Release、Actions 结果或用户闭环实测。

## 版本模型

当前策略是社区产品 Candidate Source 1:1 镜像官方内核（仅在社区自有修补时附加 `-community.N`）。同时，`Candidate Source` 与 `Published Latest` 是两条独立状态。

| 层级 | 当前值 | 应如何理解 |
|---|---|---|
| Official core pin | `@deepseek-ai/dsh@0.2.2-rc.3` | 官方内核 |
| Candidate community product | `0.2.2-rc.3-community.2` | **待发布的源码候选；尚无该版本签名资产** |
| Last signed Community Pre-release | [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1) | 2026-11-17 已发布，并通过 exact-tag artifact-smoke；与候选 `.2` 分离 |
| Published Latest | `v0.2.2-rc.3` | GitHub Latest；普通用户主下载入口 |
| Historical tags | `v0.1.2`–`v0.1.6`, `v0.1.1-rc.2`, `v0.2.2-rc.2`, `v0.2.2-rc.2-community.1` | 已被 `v0.2.2-rc.3` 替代 |

Desktop 与 TUI 的版本身份必须同时显示 Dual-Badge（当前 Candidate Source / Pre-release）：

```text
DeepSeek Harness Community v0.2.2-rc.3-community.2 [Official Core: @deepseek-ai/dsh@0.2.2-rc.3]
```

## 用户选择

正式入口是 [`dsh-community/releases/latest`](https://github.com/kamanager2012/dsh-community/releases/latest)。
普通用户下载 [`v0.2.2-rc.3`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3)。

`v0.2.2-rc.3`（发布 Commit `073826c38df4cf246e7ac90b27e0df98569a534d`）共上传 **12 个发行资产（3 个核心文件 + 3 个 `.sha256` 校验文件 + 6 个 keyless Cosign `.sigstore.json` 证明，不含 GitHub 自动源码归档**；Complementary Edition 发行 Linux AppImage + 已签名 Android `arm64-v8a` Remote Client APK + 官方运行时 CycloneDX SBOM，Windows Setup `.exe` 与 macOS `.dmg` 自历史 `v0.1.1-rc.2` 后退役并交还官方 `deepseek-ai/deepseek-harness`）：

- `dsh-community-0.2.2-rc.3.AppImage` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`
- `dsh-community-0.2.2-rc.3-android-arm64-v8a.apk` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`
- `dsh-community-0.2.2-rc.3-official-runtime.cdx.json` + `.sha256` + `.sigstore.json` + `.sha256.sigstore.json`

三个互补社区端为 **WSL/Linux Terminal**（已发行）、**Linux AppImage**（已发行）与 **Android Remote Client**（已签名 `arm64-v8a` APK 已在 Latest 发行；CI `x86_64` 模拟器 E2EE 验收通过，物理真机遥测保持 `[UNVERIFIED]`）。官方 Web 与 Win/macOS Desktop 是上游端，共享 `~/.dsh`，不是社区端。

## Complementary Edition Release Gate

以下是本快照对应的最新观察结果：

| Gate | 状态 | 事实 |
|---|---|---|
| 普通 `dsh-community` CI | `[REAL]` | 主线 typecheck（8 projects）与全量 Vitest 在 `main` 通过；但普通 CI 不替代发行包验收 |
| Release assets & signing | `[REAL]` | `v0.2.2-rc.3`（`releaseId=445732060`）与 Pre-release [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1)（`releaseId=448012716`，`release` [Run 44004421253](https://github.com/kamanager2012/dsh-community/actions/runs/44004421253)）均发布 12 个带 SHA-256 与 keyless cosign bundle 的资产 |
| `artifact-smoke` | `[REAL]` | `v0.2.2-rc.3`（[Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193)）及 Candidate Pre-release `v0.2.2-rc.3-community.1`（[Run 44005955539](https://github.com/kamanager2012/dsh-community/actions/runs/44005955539)）均通过 `resolve`、`linux-appimage`、`android-apk`、`linux-terminal` 与 `verify-signatures`（cosign 12 文件全验） |
| Full user loop | `[PARTIAL]` | [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) 通过 `.github/workflows/user-loop-evidence.yml` 社区 TUI ↔ 官方 `dsh --profile headless` ↔ Linux AppImage 内置运行时（`official-dsh.tar`）三方跨端 Session 接续、AppImage Electron GUI（`AppRun`）Session 可见性/Runtime/Marketplace 验证与全部 4 项生命周期恢复（前序 [Run 43713641736](https://github.com/kamanager2012/dsh-community/actions/runs/43713641736)、[Run 43709890408](https://github.com/kamanager2012/dsh-community/actions/runs/43709890408)、[Run 43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931)）；通过打包交互式 GUI / 官方 Web 提交对话轮次的接续与物理 Android 真机闭环仍待复核 |

目标链路是：

```text
tag
  → release-identity + runtime-sbom + build-linux + build-android
  → cosign keyless sign
  → publish 12 signed assets to GitHub Release
```

## Stable 发布基线与当前 Pre-release

`v0.2.2-rc.3`（Commit `073826c`）仍是当前 Published Latest；发布之后的加固与修复（`scripts/install-linux.sh` 源码安装器、无头 Chromium E2EE 验收、`observe` Git Diff 脱敏及 Codex/ACP 崩溃恢复等）已于 `2026-11-17` 打标并签发为 GitHub Pre-release [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1)（`release` [Run 44004421253](https://github.com/kamanager2012/dsh-community/actions/runs/44004421253)、`artifact-smoke` [Run 44005955539](https://github.com/kamanager2012/dsh-community/actions/runs/44005955539)），同时保持 `v0.2.2-rc.3` 的 Latest 推荐位不变。

## Distribution Reality Gate

下表记录 exact-release-artifact 证据：

| 场景 | 状态 | 必须证明 |
|---|---|---|
| Linux AppImage + `dsh-community-0.2.2-rc.3.AppImage` | `[REAL]` | [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) 完成 SHA-256、解包、headless 检查与 keyless cosign 验签；[Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) 实证内置 `official-dsh.tar` 运行时可接续共享 Session，且打包 Electron GUI（`AppRun`）可在 `#sessions-table` 中渲染该 Session ID 及复制/恢复命令操作、展示 Runtime 版本切换与 Marketplace 离线缓存回退 |
| WSL/Linux 终端 + `dsh-community` / `pnpm tui` | `[REAL]` | [Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193) 通过 help、version、缺 key doctor、sessions、无 TTY 拒绝路径；[Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) 完成社区 TUI ↔ 官方 `dsh --profile headless` ↔ AppImage 内置运行时三方接续，以及 AppImage Electron GUI 的共享 Session 可见性验证 |
| Session 闭环 | `[PARTIAL]` | 社区 TUI ↔ 官方 `dsh --profile headless` ↔ Linux AppImage 内置运行时三方共享 `~/.dsh` Session 接续，以及 Linux AppImage Electron GUI（`AppRun`）中同一共享 Session ID 与恢复命令控件的渲染可见性已通过 [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) 实证 `[REAL]`；通过官方 Web 或打包 Win·macOS / Linux Desktop 交互式界面直接续跑对话轮次的跨端接续仍为 `[待复核]` |
| Plugin / restart | `[PARTIAL]` | 9 个目录插件中 6 个已完成 `0.2.2-rc.3`（`dsh plugin add` + `--dump-config`）合成验证；其余 3 个旧插件仍为 `0.1.1-rc.2` |
| Lifecycle recovery | `[REAL]` | 缺少密钥干净拒绝（exit 2 / 0 孤儿会话）、`apps/desktop/src/host-extract.ts#ensureOfficialHostExtracted` Runtime 解压中断自愈恢复、`0.2.2-rc.2 → 0.2.2-rc.3` 版本升级（TUI profile 原地升级、历史 Session 保留与 AppImage GUI Runtime 切换）及断网处理（TUI fail-closed、Marketplace client/CLI 与 AppImage GUI 离线缓存回退）均已通过 [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) 实证 `[REAL]` |
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
