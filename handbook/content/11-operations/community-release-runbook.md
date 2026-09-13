# Community 发布 Runbook

> 事实状态：`v0.1.1-rc.1` exact-artifact smoke 已在真实 runner 上通过 `[PARTIAL]`；本文仍不把首启 smoke 当成完整用户闭环，也不把 README 声明当成运行证据。

相关入口：[当前发行状态](community-release-status.md) · [发布检查清单](release-checklist.md) · [生态与产品入口](../00-overview/community-ecosystem.md) · [dsh-community Release](https://github.com/kamanager2012/dsh-community/releases/latest)

## 当前事实边界

- 当前已发布 Latest 是 `v0.1.1-rc.1`，实际资产为 `dsh-community-0.1.1-rc.1.AppImage`、`dsh-community-0.1.1-rc.1.dmg` 和 `DSH.Community.Setup.0.1.1-rc.1.exe`，每个资产都有 `.sha256`；
- 官方内核是 `@deepseek-ai/dsh@0.1.1-rc.1`，产品号与内核 1:1 同号；历史独立编号 `v0.1.2`–`v0.1.6` 不是用户下载版本；
- Desktop/TUI Dual-Badge 必须显示：`DeepSeek Harness Community v0.1.1-rc.1 [Official Core: @deepseek-ai/dsh@0.1.1-rc.1]`；
- 五个 Community endpoint 是 WSL/Linux Terminal、Windows Desktop、macOS Desktop、Linux AppImage、Android；Android 仍在 Labs `[UNVERIFIED]`。官方 Web 是内核自带界面；
- `v0.1.1-rc.1` 真实资产的安装与 Runtime 首启 smoke 为 `[PARTIAL]`，完整用户闭环仍为 `[待复核]`；禁止把“完整安装闭环已验证”写进 Release、网页或手册；
- [Run 32489762676](https://github.com/kamanager2012/dsh-community/actions/runs/32489762676) 的 resolve、Windows、macOS、Linux 四个 job 全部通过。它覆盖 install/first-ready/missing-key 子集，不等于完整用户闭环；
- `v0.1.4` 的历史教训是：发现安装包缺官方 Runtime 依赖时，必须立即停止推广并回退 Latest，再用新的版本修复，不能移动或覆盖已经发布的 tag `[待复核]`。

## 1. 发布前冻结

在发布脚本前确认：

- 工作树干净；
- `CHANGELOG.md` 有目标版本章节；
- 目标 tag 尚不存在；
- Release 资产命名与 sha256 sidecar 规则已由 workflow/source 复核；
- 本次只发布 `dsh-community`，不能把 Suite、Edition、Marketplace 或 Plugins 当发行渠道；
- staging 未就绪时，只能继续做实验或明确标记 `[待复核]`，不能宣称 Stable 安装闭环。

## 2. `release.mjs` 的真实流程

脚本入口是 `dsh-community/scripts/release.mjs`。它接受的 tag 语法由源码固定为：

```text
node scripts/release.mjs <vX.Y.Z[-prerelease]>
```

例如社区自有修补才使用 `vX.Y.Z-community.N`；当前线是镜像官方内核 `v0.1.1-rc.1`，不要另造独立号。占位符不是要重复执行的当前 `v0.1.1-rc.1`，已发布 tag 不得重跑。

脚本按以下顺序执行：

1. 检查 tag 格式、clean tree、tag 未存在、`CHANGELOG.md` 有对应章节，并确认 push remote 是 `kamanager2012/dsh-community`；
2. 执行 `pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`；
3. 执行本地 `pnpm desktop:package -- --appimage` 作为 Linux/AppImage sanity check；
4. 创建并 push tag。tag push 会触发 GitHub `release` workflow。

任何一步失败都停止。不要用 `--force`、移动 tag 或覆盖已发布 Release 来“修复”失败资产。

## 3. 3-OS release workflow

workflow 的职责是构建和发布，不是替代用户现实门禁：

| Job | 产物 / 检查 |
|---|---|
| Linux | typecheck、test、AppImage、sha256 |
| Windows | NSIS `DSH Community Setup <version>.exe`、sha256（当前 Latest 资产名为 `DSH.Community.Setup.0.1.1-rc.1.exe`） |
| macOS | dmg、sha256 |
| publish | 收集三个 job 的资产，按 tag 创建 GitHub Release；已有 Release 时拒绝覆盖 |

只有资产真正上传且 sidecar 存在，才可以记录“Release publish 已发生” `[REAL]`。本次 exact-artifact 首启 smoke 为 `[PARTIAL]`，仍不等于完整用户闭环已验证。

## 4. SHA256 核对

核对必须针对 Release 页面下载的原始文件，不要核对 main 构建或任意重新打包文件：

```sh
sha256sum -c dsh-community-0.1.1-rc.1.AppImage.sha256
shasum -a 256 dsh-community-0.1.1-rc.1.dmg
```

Windows PowerShell：

```powershell
Get-FileHash 'DSH.Community.Setup.0.1.1-rc.1.exe' -Algorithm SHA256
```

把实际文件名、sidecar 内容、核对环境和结果写入证据记录。hash 通过只能证明文件完整性，不能证明 Runtime staging 或首对话可用。

## 5. artifact-smoke 门禁

workflow 输入支持指定 tag；复核一个已发布版本时使用真实 tag：

```sh
gh workflow run artifact-smoke.yml --repo kamanager2012/dsh-community --field tag=v0.1.1-rc.1
gh run list --repo kamanager2012/dsh-community --workflow artifact-smoke.yml --limit 1
```

这一轮 smoke 的实际范围和结果是：

- 下载 exact Windows Setup、macOS dmg 和 WSL/Linux Terminal 对应入口；
- 校验每个下载资产的 sha256；
- Windows 静默安装、macOS 挂载/启动、Linux Terminal 启动；
- 等待官方 Runtime first-ready，并检查缺 key / 失败路径；
- 检查测试进程退出，不把 smoke 进程残留当成功。

`v0.1.1-rc.1` 的 [Run 32489762676](https://github.com/kamanager2012/dsh-community/actions/runs/32489762676)
四个 job 全部通过：真实 Release 资产 checksum、Windows 静默安装/Runtime readiness、macOS
挂载启动/Runtime readiness，以及 Linux TUI 的 help/version/缺 key/无 TTY 路径均通过。
该结果标为 `[PARTIAL]`，因为它没有覆盖 Session 共享、插件重启、升级/卸载重装、网络失败或真实首对话。

artifact-smoke 不是完整用户验收。仍需单独复核：新建、恢复、官方 Web ↔ 五个 Community endpoint 的同一 `~/.dsh` Session、插件安装重启、升级、卸载重装、代理/断网和中断解压。

## 6. Latest 晋升与回退

### 晋升

Latest 晋升前必须同时有：Release 资产、sha256、3-OS workflow 结果、artifact-smoke 结果、staging 结论和人工用户闭环记录 `[待复核]`。任一项为 `NOT_READY` 或 `[待复核]`，就保持当前通道并明确标记，不得写 Stable 已验证。

### 回退

如果发现安装包缺少官方 Runtime 依赖（`v0.1.4` 的历史教训）[待复核]：

1. 立即停止推广、下载按钮和自动安装指引；
2. 立即把错误版本从 Latest 推广位回退，并保留 Release、日志、hash 和失败环境证据；
3. 不移动、不覆盖、不 force-push 已发布 tag；
4. 修复后切新的 patch/Release，重新跑 3-OS workflow、sha256 和 artifact-smoke；
5. 在 staging 和用户闭环重新复核前，所有说明保持 `[待复核]`。

## 7. 交接记录模板

```text
Release tag:
Stable / Preview:
Assets and sha256:
3-OS workflow:
artifact-smoke:
Official Runtime staging: PARTIAL / READY [待复核]
User loop:
Known failure:
Rollback decision:
Next review:
```
