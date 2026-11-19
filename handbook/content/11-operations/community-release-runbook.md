# Community 发布 Runbook

> 事实状态：`v0.2.2-rc.5` 的 12 资产 `artifact-smoke` 已在真实 runner 上通过（[Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621)），前版 `v0.2.2-rc.3` 已通过 `artifact-smoke`（[Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193)）与 `user-loop-evidence.yml`（[Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) / [Run 43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931)）验收；本文仍将首启/验签 smoke 与完整用户闭环及物理 `arm64-v8a` 真机遥测分开记录，也不把 README 声明当成运行证据。

相关入口：[当前发行状态](community-release-status.md) · [发布检查清单](release-checklist.md) · [生态与产品入口](../00-overview/community-ecosystem.md) · [dsh-community Release](https://github.com/kamanager2012/dsh-community/releases/latest)

## 当前事实边界

- 当前 Published Latest 是 `v0.2.2-rc.5`（[Run 44453540672](https://github.com/kamanager2012/dsh-community/actions/runs/44453540672) / `artifact-smoke` [Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621)），共 **12 个已签名资产**：`dsh-community-0.2.2-rc.5.AppImage`、`dsh-community-0.2.2-rc.5-android-arm64-v8a.apk`、官方运行时 CycloneDX SBOM `dsh-community-0.2.2-rc.5-official-runtime.cdx.json`，以及各自的 `.sha256` 与 `.sigstore.json` keyless cosign bundle；
- 官方内核是 `@deepseek-ai/dsh@0.2.2-rc.5`，Published Latest `v0.2.2-rc.5` 现已替代此前 `v0.2.2-rc.3` 及历史预发布 [`v0.2.2-rc.3-community.1`](https://github.com/kamanager2012/dsh-community/releases/tag/v0.2.2-rc.3-community.1)；历史独立编号 `v0.1.2`–`v0.1.6` 与 Win/macOS 安装包（`v0.1.1-rc.2` 之后已退役）均不是当前用户下载；
- Desktop/TUI Dual-Badge 显示：`DeepSeek Harness Community v0.2.2-rc.5 [Official Core: @deepseek-ai/dsh@0.2.2-rc.5]`；
- 三个互补 Community endpoint 为 WSL/Linux Terminal、Linux AppImage、Android Remote Client（已签名 `arm64-v8a` APK 已在 Latest 发行；CI `x86_64` 模拟器 E2EE 验收通过，物理真机遥测 `[UNVERIFIED]`）。官方 Web 与 Win/macOS Desktop 归官方上游所有；
- `v0.2.2-rc.5` 真实资产在 [Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621) 通过 `resolve`、`linux-appimage`、`android-apk`、`linux-terminal` 与 `verify-signatures`（12 资产全验）；此前 `v0.2.2-rc.3` 的 WSL/Linux 用户闭环在 [Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796) / [Run 43688556931](https://github.com/kamanager2012/dsh-community/actions/runs/43688556931) 通过 `[REAL]`；物理 `arm64-v8a` 真机遥测保持 `[UNVERIFIED]`；
- 发现安装包缺官方 Runtime 依赖时，必须立即停止推广并回退 Latest，再用新 tag 修复，不能移动或覆盖已发布 tag。

## 1. 发布前冻结

在执行发布脚本前确认：

- 工作树干净；
- `CHANGELOG.md` 有目标版本章节，`package.json` 与 `packages/dsh-bridge/src/pin.ts` 已对齐；
- 目标 tag 尚不存在，且通过 `node scripts/validate-release-tag.mjs <tag>` 与 `node scripts/validate-published-latest.mjs`；
- 本次只发布 `dsh-community`，不把 Suite 或内部工作区当作公共 npm 包发布；
- 完整人工首对话尚未跑完前，诚实标记 `[UNVERIFIED]` / `[待复核]`。

## 2. `release.mjs` 的真实流程

脚本入口是 `dsh-community/scripts/release.mjs`。它接受的 tag 语法由源码固定为：

```text
node scripts/release.mjs <vX.Y.Z[-prerelease]>
```

社区自研补丁才使用 `vX.Y.Z-community.N`；常规上游镜像同步直接使用 `vX.Y.Z[-prerelease]`（如当前 `v0.2.2-rc.5`），且已发布 tag 不得重跑。

脚本按以下顺序执行：

1. 检查 tag 格式、`validate-published-latest.mjs`、clean tree、tag 未存在、`CHANGELOG.md` 有对应章节，并确认 push remote 是 `kamanager2012/dsh-community`；
2. 执行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`；
3. 执行本地 `pnpm desktop:package -- --appimage` 作为 Linux AppImage sanity check；
4. 创建并 push tag。tag push 会触发 GitHub `release` workflow。

任何一步失败都停止。不要用 `--force`、移动 tag 或覆盖已发布 Release 来“修复”失败资产。

## 3. Complementary Edition `release.yml` workflow

workflow 的职责是验证身份、生成 SBOM、构建 Linux AppImage、keyless 签名并发布：

| Job | 产物 / 检查 |
|---|---|
| `release-identity` | 校验 immutable release tag 身份与当前 Published Latest 真源 |
| `runtime-sbom` | 生成并校验官方运行时 CycloneDX SBOM（`.cdx.json`）及 `.sha256` |
| `build-linux` | `typecheck`、全量 `pnpm test`、Linux AppImage、`asar-purity` vendor=0 校验、`.sha256` |
| `build-android` | `verify-android-release-ready.mjs --allow-emulator-verified`、已签名 `arm64-v8a` APK、零内嵌 Node/DSH 校验、`apksigner verify`、`.sha256` |
| `sign` | 使用 Sigstore keyless OIDC（`cosign sign-blob --yes --bundle`）签名全部产物与 `.sha256` |
| `publish` | 校验签名 bundle、生成 Release notes 并按 tag 创建 GitHub Release（拒绝覆盖已有 Release） |

Windows 与 macOS 打包 job 已在 Complementary Edition 收敛后移除，由上游 `deepseek-ai/deepseek-harness` 官方交付。

## 4. SHA-256 与 Cosign Keyless 核对

核对必须针对 Release 页面下载的原始文件：

```sh
sha256sum -c dsh-community-0.2.2-rc.5.AppImage.sha256
cosign verify-blob dsh-community-0.2.2-rc.5.AppImage \
  --bundle dsh-community-0.2.2-rc.5.AppImage.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/kamanager2012/dsh-community/\.github/workflows/release\.yml@refs/tags/v0\.2\.2-rc\.5$'
```

签名与哈希通过仅证明构建与供应链完整性 `[REAL]`，不能代替官方 Runtime 就绪或人工首对话验收。

## 5. `artifact-smoke` 门禁

workflow 输入支持指定 tag；复核已发布版本时使用真实 tag：

```sh
gh workflow run artifact-smoke.yml --repo kamanager2012/dsh-community --field tag=v0.2.2-rc.5
gh run list --repo kamanager2012/dsh-community --workflow artifact-smoke.yml --limit 1
```

最近一次 `v0.2.2-rc.5` 对应 [Run 44454406621](https://github.com/kamanager2012/dsh-community/actions/runs/44454406621)，通过 `resolve`、`linux-appimage`、`android-apk`、`linux-terminal` 与 `verify-signatures`（12 资产全验）；前版 `v0.2.2-rc.3` 已由 `artifact-smoke`（[Run 43696414193](https://github.com/kamanager2012/dsh-community/actions/runs/43696414193)）及社区 TUI ↔ 官方 `dsh --profile headless` ↔ Linux AppImage 内置运行时（`official-dsh.tar`）三方跨端 Session 接续闭环、Linux AppImage Electron GUI（`AppRun`）Session 可见性/Runtime/Marketplace 离线缓存实测，以及全部 4 项生命周期恢复（缺 Key 拒绝、`ensureOfficialHostExtracted()` 解压中断恢复、版本升级、断网缓存回退）的 `user-loop-evidence.yml`（[Run 43729024796](https://github.com/kamanager2012/dsh-community/actions/runs/43729024796)，前序 [Run 43713641736](https://github.com/kamanager2012/dsh-community/actions/runs/43713641736)、[Run 43709890408](https://github.com/kamanager2012/dsh-community/actions/runs/43709890408)）验证（`v0.2.2-rc.5` 二进制的独立真模型 `user-loop-evidence.yml` 仍待复验）。

## 6. Latest 晋升与回退

### 晋升

仅当真实 Release 创建完成（12 个签名资产齐全）且 `artifact-smoke` 通过后再更新 `docs/current-release.json` / `docs/current-release.md` 同步 Published Latest 记录；不要混淆 Candidate Source 与 Published Latest，也不要将 `[PARTIAL]` 写成完整安装闭环。

### 回退

如果发现安装包存在官方 Runtime 依赖或严重回归问题：

1. 立即停止推广并撤回 Latest 推荐位；
2. 保留故障 Release、日志、hash 与失败环境证据；
3. 不移动、不覆盖、不 force-push 已发布 tag；
4. 修复后切新的 tag（例如 `-community.N` 或新 rc）重走完整发布与 `artifact-smoke`。

## 7. 交接记录模板

```text
Release tag:
Official core / Candidate Source:
Assets, SHA256 & Cosign bundles:
release.yml run:
artifact-smoke run:
User loop: UNVERIFIED / PARTIAL / REAL
Known limits:
Next review:
```
