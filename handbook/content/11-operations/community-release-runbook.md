# Community 发布 Runbook

> 事实状态：`v0.2.2-rc.3` 的 `artifact-smoke` 已在真实 runner 上通过 `[PARTIAL]`（[Run 43663270841](https://github.com/kamanager2012/dsh-community/actions/runs/43663270841)）；本文仍不把首启与验签 smoke 当成完整用户闭环，也不把 README 声明当成运行证据。

相关入口：[当前发行状态](community-release-status.md) · [发布检查清单](release-checklist.md) · [生态与产品入口](../00-overview/community-ecosystem.md) · [dsh-community Release](https://github.com/kamanager2012/dsh-community/releases/latest)

## 当前事实边界

- 当前 Published Latest 是 `v0.2.2-rc.3`，共 **8 个已签名资产**：`dsh-community-0.2.2-rc.3.AppImage`、官方运行时 CycloneDX SBOM `dsh-community-0.2.2-rc.3-official-runtime.cdx.json`，以及各自的 `.sha256` 与 `.sigstore.json` keyless cosign bundle；
- 官方内核是 `@deepseek-ai/dsh@0.2.2-rc.3`，产品 Candidate Source 与内核 1:1 同号；历史独立编号 `v0.1.2`–`v0.1.6` 与 Win/macOS 安装包（`v0.1.1-rc.2` 之后已退役）均不是当前用户下载；
- Desktop/TUI Dual-Badge 必须显示：`DeepSeek Harness Community v0.2.2-rc.3 [Official Core: @deepseek-ai/dsh@0.2.2-rc.3]`；
- 三个互补 Community endpoint 为 WSL/Linux Terminal、Linux AppImage、Android Remote Client（`apps/android` `[UNVERIFIED]`，不进 Latest）。官方 Web 与 Win/macOS Desktop 归官方上游所有；
- `v0.2.2-rc.3` 真实资产在 [Run 43663270841](https://github.com/kamanager2012/dsh-community/actions/runs/43663270841) 通过 `resolve`、`linux-appimage`、`linux-terminal` 与 `verify-signatures`，仍属 `[PARTIAL]`，完整用户闭环保持 `[UNVERIFIED]` / `[待复核]`；
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

社区自研补丁才使用 `vX.Y.Z-community.N`；常规上游镜像同步直接使用 `vX.Y.Z[-prerelease]`（如当前 `v0.2.2-rc.3`），且已发布 tag 不得重跑。

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
| `sign` | 使用 Sigstore keyless OIDC（`cosign sign-blob --yes --bundle`）签名全部产物与 `.sha256` |
| `publish` | 校验签名 bundle、生成 Release notes 并按 tag 创建 GitHub Release（拒绝覆盖已有 Release） |

Windows 与 macOS 打包 job 已在 Complementary Edition 收敛后移除，由上游 `deepseek-ai/deepseek-harness` 官方交付。

## 4. SHA-256 与 Cosign Keyless 核对

核对必须针对 Release 页面下载的原始文件：

```sh
sha256sum -c dsh-community-0.2.2-rc.3.AppImage.sha256
cosign verify-blob dsh-community-0.2.2-rc.3.AppImage \
  --bundle dsh-community-0.2.2-rc.3.AppImage.sigstore.json \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/kamanager2012/dsh-community/\.github/workflows/release\.yml@refs/tags/v0\.2\.2-rc\.3$'
```

签名与哈希通过仅证明构建与供应链完整性 `[REAL]`，不能代替官方 Runtime 就绪或人工首对话验收。

## 5. `artifact-smoke` 门禁

workflow 输入支持指定 tag；复核已发布版本时使用真实 tag：

```sh
gh workflow run artifact-smoke.yml --repo kamanager2012/dsh-community --field tag=v0.2.2-rc.3
gh run list --repo kamanager2012/dsh-community --workflow artifact-smoke.yml --limit 1
```

最近一次 `v0.2.2-rc.3` 对应 [Run 43663270841](https://github.com/kamanager2012/dsh-community/actions/runs/43663270841)，通过 `resolve`、`linux-appimage`、`linux-terminal` 与 `verify-signatures` `[PARTIAL]`；完整用户闭环仍需通过 `user-loop-evidence.yml` 或人工记录单独验证（`~/.dsh` 跨端读写、插件重启、断网与升级恢复）。

## 6. Latest 晋升与回退

### 晋升

仅当真实 Release 创建完成（8 个签名资产齐全）且 `artifact-smoke` 通过后再更新 `docs/current-release.json` / `docs/current-release.md` 同步 Published Latest 记录；不要混淆 Candidate Source 与 Published Latest，也不要将 `[PARTIAL]` 写成完整安装闭环。

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
