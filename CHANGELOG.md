# Changelog

## Unreleased

- Android APK app-UID Reality Gate 前移到正式 bootstrap：新增 `android-app-uid-preflight.cjs`，官方 DSH spawn 前先在 Android app data 目录执行真实 Node `fs.linkSync()`（校验 inode / link count / 内容），再用 frozen `landlock-run` 在同一 APK UID 下执行 exact full probe、授权目录写入和同 UID 兄弟目录拒绝。任一失败直接拒绝启动官方 DSH；源码存在不会自动改写 `reality-gate.json`。
- `RuntimeService` 预先固定未来 verified carrier 的环境契约：`DSH_ANDROID_APP_DATA_DIR = filesDir`、`DSH_ANDROID_CACHE_DIR = cacheDir`、`DSH_RUNTIME_PORT`。因此 app-private hard-link 与 sandbox 证据不能被 Termux、`/data/local/tmp` 或 adb-shell UID 冒充。

- Android sandbox G2 从“官方 local provider 无 Android platform chain”推进到正式 provider seam：新增 `android-sandbox-provider.mjs` + `android.cordis.patch.yml`，由官方 `dsh web --patch` 只替换 `ctx.sandbox` row，不改官方 bundle、不接管 Agent/Session/tool authority。provider 使用官方 `writableRoots(policy)`，保留 `exit 125 + landlock-run:` runner-failure 语义，并且只有 `landlock: fully enforced` 才声明 full，partial 直接 fail-closed。
- frozen runtime 已确认 `@deepseek-ai/node-addon-landlock-run@0.1.1` npm payload 自带 `src/main.c`。新增 `scripts/android-sandbox-landlock-probe.sh`，直接用 Android NDK 原样编译该官方源码；可选 adb-shell smoke 验证 full probe、workspace write 与越界写拒绝，但输出明确标记 `NOT_APP_UID_ACCEPTANCE`，不能代替 APK app UID Reality Gate。
- PTY blocker 重新裁决：普通 `LocalSubprocessRuntime.spawn()` 不依赖 terminal inspector，Web 默认 `standard` 也不挂 PTY；但 shipped `minimal` 仍对用户可选且使用 persistent PTY，而 AgentPresets 没有 preset allowlist。官方 `terminalInspector` 属性明确是 test hook，因此不采用该捷径；完整 Android endpoint 仍需正式 Android SubprocessRuntime provider 或上游 PTY 支持。

- Android G2 portable dependency 裁决继续收敛：新增网络隔离的 `scripts/audit-android-portable-deps.mjs`，直接从 committed alpha.4 runtime lock 固定 `sharp@0.35.4 → @img/sharp-wasm32@0.35.4 → @emnapi/runtime@1.11.3` 的 exact registry/integrity provenance；同时确认 lock 元数据不等于 host-specific staging 已物化 optional WASM bytes。
- `scripts/android-native-addon-probe.sh` 的真机模式新增 sharp WASM 2×2 PNG smoke。若 frozen staging 缺少 `@img/sharp-wasm32` 或依赖，明确报 materialization gap；只有 Android Node carrier 实际生成合法 PNG 才能把 `sharpFallback` 证据升级。
- ripgrep blocker 从“缺 Android binary”进一步收紧为 wrapper/seam blocker：`@vscode/ripgrep@1.18.0` 会解析不存在的 `@vscode/ripgrep-android-*`，DSH sidecar 又仅用于 `process.pkg`。供应链身份固定为 Microsoft `ripgrep-prebuilt v15.0.1` → BurntSushi/ripgrep `15.0.0` + Microsoft patch；禁止伪造 `@vscode` 包、spoof `process.pkg`、依赖 Termux/system rg 或替换未钉最新版。

- Android G2 从“native closure 总阻断”拆成可执行的 addon/语义双门禁：新增 `apps/android/native-compatibility.json` 与手工 `scripts/android-native-addon-probe.sh`。probe 只接受 frozen alpha.4 runtime、精确 Node 22.19.0 carrier source/build、Android NDK 与可选 adb；不下载、不修改上游源码，原样重建 `node-pty@1.2.0-beta.15` 和 `koffi@3.1.6`，真机执行 FFI + PTY smoke。
- Koffi blocker 口径修正：3.1.6 已在 Android/Termux 已知构建问题修复之后，故从“无路”改为 `CROSS_BUILD_PROBE_REQUIRED`，但官方支持矩阵仍无 Android，不能升级 PASS。node-pty 精确绑定 upstream `v1.2.0-beta.15` commit `8f218f6c194be81d98b1eeea344b150e83445824`。
- 新增不能被 addon PASS 覆盖的 Android 语义门：`subprocess-local` terminal inspector 无 Android branch、`sandbox-local` 无 Android platform chain、session/attachment 的 POSIX `link()` 必须在 APK 私有目录验证；sharp 0.35.4 WASM fallback 与 Android ripgrep 仍保持独立未验证状态。Release verifier 已要求这些 G2 子门全部 PASS。

- Android G0 安装闭包审计落地：新增 `scripts/audit-android-official-cli-closure.mjs`，直接读取 committed alpha.4 runtime lock，验证 `@deepseek-ai/dsh → dsh-base/sdk-minimal/tool-fs-search → subprocess/attachment/sandbox/fs-search → node-pty/koffi/sharp/ripgrep` 的真实依赖边。当前机器裁决为 `BLOCKED_BY_NATIVE_CLOSURE`，且 `profileOnlyMitigation=INEFFECTIVE`：disable Cordis row 不能删除 npm 安装依赖。
- Android 路线因此进一步收敛：默认坚持顶层官方 `@deepseek-ai/dsh`，优先解决/交叉构建 native closure；只有官方上游包拓扑变化才重新裁决。绕开顶层 CLI、仅组装底层官方模块不会被偷偷采用，因为那会改变“官方发布 CLI 是 Runtime 真源”的产品边界。

- Android carrier provenance 与发布门禁继续收紧：官方 Node `v22.19.0` 候选不再只校验版本宏，现精确绑定 GitHub verified annotated tag object `a9d4750074c7b5439c61daa28ea9afb5dc28e43e` 及其 commit `f8fe6858549f75a4b4e9633abf39dd2038dbf496`；手工 probe 同时校验 tag object、peeled commit、HEAD 与 tracked source clean state。
- 新增 Android fail-closed 发布资格检查 `node scripts/verify-android-release-ready.mjs`：当前 `runtime substrate=BLOCKED`、native blockers=`OPEN`、Reality Gate=`NOT_RUN` 时必须非零退出。只有 carrier/native closure/DSH boot/APK 双架构 smoke、真机身份、carrier/APK SHA-256 与 App runtime gate 全部一致 PASS 才能进入发布；普通 CI 只验证“当前应被阻断”，不伪造真机证据。

- Android Local runtime 路线继续推进到第二层 Reality Gate：stock nodejs-mobile 因 Node 18.20.4 与 DSH alpha.4 的 Node 22.19+ 要求冲突继续判 `BLOCKED`，但已确认官方 Node `v22.19.0` 源码仍保留 Android NDK 交叉编译入口。新增 `scripts/android-node22-probe.sh`，只接受调用方提供的官方 Node 源码/NDK，必须在真机通过 `process.versions.node=22.19.0` 与 `process.platform=android` 才能升级 carrier 证据；普通 CI 不运行这个重型 gate。
- 新增 `apps/android/native-blockers.json`：完整 Web 与官方 `sdk-minimal` 都不能仅靠 Node 22 自动成立，当前硬阻断包括 `dsh-subprocess-local → node-pty/koffi`、`dsh-attachment-local → sharp`、`dsh-sandbox-local` 的平台 native backend；`dsh-tool-fs-search → @vscode/ripgrep` 为 feature blocker。Android 第五端继续保留，不转成 Remote-only，也不引入 Codex。

- Terminal 初始任务传输收紧：`dsh-community new <任务>`、简写任务和 resume 后续任务不再进入官方子进程 argv，而是由社区 TUI 启动后经现有 `DSH_TUI_FIRST_PROMPT` 一次性接收、立即从进程环境删除，并通过官方 `agent.followup` seam 提交。该改动只声明消除普通 process-list/argv 暴露，不把环境变量冒充秘密存储。
- Android 活跃源码的本地 Web bootstrap 明确使用 `--host 127.0.0.1 --no-open`，并拒绝非法端口；新增静态契约固定 exact `@deepseek-ai/dsh@0.1.2-alpha.4`、loopback 边界和 `[UNVERIFIED]` Reality Gate 状态，不虚构真机证据。
- Android runtime substrate 事实收紧：官方 DSH alpha.4 要求 Node `^22.19.0 || >=24.0.0`，而 2026-09-02 实测上游 stock nodejs-mobile 最新 Android release 为 Node 18.20.4，因此机器状态明确为 `BLOCKED`。移除未验证的 `com.github.nodejs-mobile` Gradle 插件声明，Android 壳在 gate 关闭时 fail-loud 展示未验证状态，不再伪装 embedded runtime 已启动；第五 Community endpoint 仍保留为活跃源码。

- Release identity contract now separates **Candidate Source** from **Published Latest**: candidate core/product/tag and Dual-Badge may advance for review while GitHub Latest and installer names remain bound to the last real release. The validator also rejects ranged official-runtime pins and fabricated candidate assets. Desktop readiness accepts the official alpha.3 `?token=` bootstrap URL only on canonical loopback HTTP. Lifecycle state returns only the clean origin; the credential is retained only in a one-shot in-process browser-bootstrap channel, redacted from diagnostics, exchanged by the official Web surface for its signed cookie, then discarded.
- Release 供应链新增 **official-runtime CycloneDX SBOM**：使用 Node/npm 自带 `npm sbom --package-lock-only` 从 committed runtime lock 生成，只声明嵌入的官方 DSH 依赖树而不冒充整个 Electron 产品 SBOM。SBOM 作为正式 release asset 必须有独立 SHA256 与 Sigstore bundle；pre-publish verifier 要求唯一一份有效 CycloneDX、根组件正确且包含精确官方 DSH，否则拒绝发布。新增只读 PR smoke 真实生成并复算 checksum。
- Desktop 官方 Runtime 的安装脚本执行面改为 deny-by-default：staging 先 `npm ci --ignore-scripts`，再只 rebuild 4 个已审查包（`@deepseek-ai/dsh-subprocess-local`、`koffi`、`node-pty`、`protobufjs`）；`@google/genai@1.52.0` 明确保持禁止执行。机器契约要求 runtime lock 中全部 `hasInstallScript` 条目必须与 lifecycle policy 精确一致，所有非根 tarball 必须来自 `registry.npmjs.org` 且带 sha512 integrity。真实 Windows/Linux/macOS package smoke 均通过。
- Desktop 三平台打包前移到 PR 验收：Windows NSIS、Linux AppImage、macOS DMG 均使用与正式 Release 相同的 packaging 命令。Linux 额外完成 AppImage 无 FUSE 解包并找到 `resources/app.asar`；macOS 实际挂载 DMG 并确认 `.app/Contents/MacOS` 可执行文件；三平台继续执行 asar vendor=0 与 SHA256 校验。首轮真实 Linux AppImage 为 189,145,947 bytes，macOS DMG 为 169,845,018 bytes。
- Release tag 身份统一为单一机器规则：本地 `scripts/release.mjs` 与 GitHub `release` workflow 共用 canonical validator；手工 push 的 `v*` tag 必须与 workspace 产品号、官方 DSH pin、`current-release.json`、Dual-Badge、资产名与 CHANGELOG 一致，三个 OS build 才会启动；sole `contents: write` publisher 仅在所有依赖 job `success()` 后运行。
- Desktop 官方 Runtime 暂存改为可复现依赖树：runtime-only npm `package-lock.json` 当前为 597 entries，非根条目全部有 `resolved + sha512 integrity`；alpha.3 最终 lock 由 GitHub Actions run `33540607690` / job `99965617854` 在 Ubuntu 24.04、Node v22.23.2、npm 10.9.8 上生成并由 bot commit `4458655c...` 直接写回，provenance 不再冒充旧 artifact 中转。`stage-official-runtime.mjs` 继续只从 committed lock + `npm ci` 暂存。
- OSS 维护入口补齐：外部贡献指南、治理、行为准则、支持路由、Issue/PR 模板与 CODEOWNERS 现在统一公开；项目仍诚实标注为单维护者，不虚构多人 maintainer。
- 修复 upstream-contract 对 Marketplace 元数据的误判：`packages/marketplace/catalog.json` 允许引用第三方包作为注册表元数据，但 runtime manifest / composition / patch 仍禁止挂载第三方 Harness/TUI；主 CI 恢复为真实绿灯。
- 修正此前对 Android 的错误归档：产品边界恢复为 **5 个 Community endpoints**（WSL/Linux Terminal、Windows Desktop、macOS Desktop、Linux AppImage、Android）。Android 既有 Kotlin/WebView 壳、目标 Node project 与 Termux Reality Gate 已从 archived Labs 恢复到本仓 `apps/android` / `scripts/termux-verify.sh` 活跃主线，并对齐官方 `@deepseek-ai/dsh@0.1.2-alpha.4`；其证据状态仍为 `[UNVERIFIED]`，不会在未通过 Android Reality Gate 前伪装成 Published Latest。
- 依赖维护收紧：Dependabot 每周监控 npm 与 GitHub Actions，routine 自动升级限制为 minor/patch；semver-major 必须显式兼容性评审，pre-1.0 的 `esbuild` 跨 minor 也不混入日常机器人 PR。依赖变更 PR 与每周计划任务新增 `pnpm audit --audit-level high`，首轮真实 audit 输出 `No known vulnerabilities found`。
- GitHub Actions 供应链加固：所有外部 Actions 固定到完整 commit SHA，checkout 禁止持久化仓库凭据；checkout / setup-node / pnpm bootstrap 与 artifact upload/download 已迁到 Node 24 action majors，并分别通过 CI、插件 compose/validate、dependency audit 和真实 artifact upload→download→SHA256 round-trip 验证。
- Release 发布前闭环加固：sole `contents: write` publish job 在 `gh release create` 前重新校验跨平台 release set、实算 SHA256、拒绝缺失/孤儿 sidecar 或 Sigstore bundle，并对每个 asset 用当前**精确 tag** 的 Fulcio workflow identity 执行 `cosign verify-blob`。
- Post-release `artifact-smoke` 改为单次解析一个 exact tag，签名验证与 Windows/macOS/Linux smoke 共用同一 release identity；cosign 从 repo-wide tag regex 收紧为 exact tag identity。零 bundle 只允许 8 个明确的 pre-signing 历史 tag，新/未知 unsigned release 直接失败。PR 修改 smoke 逻辑时会真实验证当前签名 Release，但跳过重型 endpoint 安装 smoke。
- Windows Release 不再执行 `Set-MpPreference` 关闭 Defender。新增 `windows-package-smoke` 在真实 `windows-latest`、主机防护保持开启时完成 frozen install → typecheck → NSIS → asar vendor=0 → SHA256 → installer/sidecar 检查；CI 同时禁止重新引入关闭 Defender 的命令。
- 新增手动、billable 的 exact-release WSL/Linux user-loop evidence gate：`new → real model ACK → clean exit → resume same official Session → second real model ACK`，隔离 `DSH_HOME` 且只输出脱敏证据。当前仍保持 `[UNVERIFIED]`，直到有真实 `DEEPSEEK_API_KEY` 的成功 Release run，workflow 存在本身不升级证据等级。
- Marketplace CLI 并入本仓 `packages/marketplace`（`pnpm marketplace`）。独立仓 `dsh-marketplace`、`dsh-community-plugins` 与 Community Labs `deepseek-harness-suite` 已归档。插件兼容性目录现为 `packages/marketplace/catalog.json`。
- `DshMcpBridge` 从 `@dsh-community/dsh-bridge` 导出。Windows / macOS 发行任务在打包后同样跑 asar vendor=0 护栏。

## 0.1.2-alpha.4 — Candidate Source (2026-09-02)

This is a reviewed **Candidate Source**, not GitHub Published Latest. Published Latest remains `v0.1.1-rc.2`. Consolidated alpha.4 acceptance passed and `latest-tested` advances to alpha.4.

- Exact npm registry existence was verified before the bump.
- Workspace product/core identity, direct official dependencies, TUI official peers, pnpm lock, and the complete Desktop DSH runtime closure are exact `0.1.2-alpha.4`.
- Official contracts were freshly extracted: Web config rows **146 → 145** and published package surface **145 → 144**, both removing the subagent-report surface; launcher/Web must-contain CLI grammar and readiness prefix remain stable.
- Alpha.4 retains the one-time Web browser token bootstrap protocol already handled by the Community Host; no new credential surface is introduced.
- Upstream profile documentation expands the documented product composition around `acp`, `sdk`, and `sdk-minimal`, while the CLI argument parser implementation remains unchanged.
- Desktop runtime lock is **580 entries** with **214 DSH-family entries**, all exact alpha.4. The reviewed five-package lifecycle-script name set is unchanged.
- pnpm release-age protection required 29 newly enumerated exact alpha.4 package exemptions; no broad `@deepseek-ai/*` exemption was introduced.
- Candidate acceptance, plugin `testedDsh`, Published Latest, published installers, and User-Loop evidence remain independent gates.
- Promoted-tree consolidated acceptance replay run `33577261413` passed with **79 test files / 323 tests passed, 1 file / 1 test skipped**, 214 exact alpha.4 DSH runtime entries, npm audit 0 vulnerabilities, authenticated official-Web lifecycle, and 9-plugin offline marketplace verification. `latest-tested` remains alpha.4 on this final replay evidence; Published Latest, plugin `testedDsh`, installers, and User-Loop evidence do not move.

## 0.1.2-alpha.3 — Candidate Source (2026-09-02)

This is a reviewed **Candidate Source**, not GitHub Published Latest. Published Latest remains `v0.1.1-rc.2` until the independent release gate is completed.

- Workspace product/core identity and all direct official DSH dependencies are exact `0.1.2-alpha.3`; TUI official peers are exact alpha.3 as well.
- Official contracts were freshly extracted from alpha.3: Web config rows **135 → 146** (+13/-2), published package surface **134 → 145** (+13/-2), while launcher/Web must-contain CLI grammar and readiness prefix remain stable.
- The published `@deepseek-ai/dsh` manifest no longer includes the top-level `config` directory in its `files` list; Community code follows the supported profile/config-tree surface instead of packaged config files.
- After upstream alpha.4 became available, plain npm prerelease-range resolution produced a mixed Desktop runtime (alpha.3 root with alpha.4 DSH transitives). The committed runtime manifest now freezes the complete published DSH family to alpha.3, including peer-resolved `dsh-brand`, `dsh-credentials`, and `dsh-session`; regenerated runtime lock contains **zero alpha.4 DSH packages**.
- The reviewed lifecycle-script package-name set remains unchanged: allowed `dsh-subprocess-local`, `koffi`, `node-pty`, `protobufjs`; denied `@google/genai`.
- `latest-tested`, plugin `testedDsh`, Published Latest, published installers, and real User-Loop evidence do **not** advance merely because Candidate Source advanced.
- Final promoted-tree alpha.3 acceptance passed on run `33569520030`: frozen install, zero contract re-extract drift, exact runtime closure, npm audit 0 vulnerabilities, typecheck, **322 passed / 1 skipped** tests, authenticated official-Web bootstrap, and marketplace offline verification. On that evidence `latest-tested` advances to alpha.3; plugin `testedDsh`, Published Latest, published installers, and User-Loop evidence remain on their independent states.
- Upstream `0.1.2-alpha.4` is recorded as `NEXT_UPGRADE_CYCLE`; it is not mixed into this acceptance baseline.

## 0.1.1-rc.2 — 2026-08-22

Pin bump:官方 Runtime `@deepseek-ai/dsh` `0.1.1-rc.1` → `0.1.1-rc.2`(官方 GitHub 当前发行 / npm `latest` 与 `next`)。社区产品号 1:1 镜像为 `0.1.1-rc.2`。

- 契约面零漂移:`web --dump-default-config` 仍 135 行,id 与相对顺序和 rc.1 快照一致;launcher 五 token 与 web 三旗标不变;readiness 前缀 `dsh web: ` 不变(隔离 DSH_HOME 运行时探针实证)。
- 静态 tarball 全量对比:54 个子包中 49 个仅版本号变化,4 个差异全部集中在图片附件域且为纯增量(`dsh-goal` / `dsh-session-reference` 给 `ImageAttachmentRef` 加可选 `originalDimensions`;`dsh-tool-fs` 精简 `read_image` 描述);零删除行,无破坏性变更。
- 契约快照按 `0.1.1-rc.2` 重抽;`latest-tested` 改为 `0.1.1-rc.2`;compatibility matrix 新增 rc.2 行(desktop 发布冒烟待跑)。
- 下个 tag 起发行产物走 keyless cosign 签名(`docs/release.md`)。

## 0.1.1-rc.1 — 2026-08-21

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.1-rc.1

社区产品号 1:1 镜像官方当前核心 **0.1.1-rc.1**。这是按版本策略发出的当前下载，取代此前自编的 `v0.1.2` / `v0.1.3` / `v0.1.4` / `v0.1.6` 号（那些 tag 保留为历史记录，不再当 Latest）。

- 官方 Runtime pin：`@deepseek-ai/dsh` `0.1.0-rc.8` → `0.1.1-rc.1`（官方 GitHub 当前发行 / npm `latest` 与 `next`）。社区套件 1:1 镜像为 `0.1.1-rc.1`，不再带 `-community.N`。
- Dual-Badge：`DeepSeek Harness Community v0.1.1-rc.1 [Official Core: @deepseek-ai/dsh@0.1.1-rc.1]`。Desktop 顶栏 / About 与 TUI 状态栏同一字符串。
- 产品端定义为五个社区端：WSL/Linux 终端、Windows 桌面、macOS 桌面、Linux AppImage、Android（Labs / `[UNVERIFIED]`）。官方 Web 仍不是 Community 发行端。
- 保留 rc.8 工程修复：Desktop `--no-open`、readiness 跳过非 URL 行、Node `>=22.15.0`。
- 契约快照按 `0.1.1-rc.1` 重抽；`latest-tested` 改为 `0.1.1-rc.1`。
- macOS 发版暂存官方 Runtime 时把 Node 堆提到 4GB，避免 GitHub runner 上 `npm install` OOM。
- Windows 暂存检查认 `node-pty` 1.2 的 `conpty.node`（不再误找已移除的 `pty.node`）。

## 0.1.0-rc.8-community.1 — Unreleased (superseded in source)

- 版本身份契约：社区发行线镜像官方核心版本；当前未发布线为 `0.1.0-rc.8-community.1`，对应 `@deepseek-ai/dsh@0.1.0-rc.8`。Desktop 与 TUI 统一显示 Dual-Badge：`DeepSeek Harness Community v0.1.0-rc.8-community.1 [Official Core: @deepseek-ai/dsh@0.1.0-rc.8]`。已发布的 `v0.1.6` 保留为历史版本。
- 发行文档对齐 0.1.6：`docs/release.md` Distribution Reality Gate 与 `ECOSYSTEM.md` 验包路径从 0.1.4 升到当前 Latest 产物名；门禁仍标 `[UNVERIFIED]`（待 clean-machine exact artifact 重跑）。

- 修复根目录 `pnpm start` / `tui` / `sessions` / `run doctor`：改走 `@dsh-community/tui`（`apps/tui`）入口，不再误调没有 `start` 的 `@dsh-community/tui-surface`。文档用 `pnpm run doctor`，避免撞上 pnpm 内置 `doctor`。

- 官方 Runtime pin：`@deepseek-ai/dsh` `0.1.0-rc.6` → `0.1.0-rc.8`（官方 GitHub 当前发行 / npm `next`）。npm `latest` 仍是 `0.1.0-rc.7`，本仓跟官方仓库当前表面，不跟 npm latest。
- Desktop / dsh-bridge spawn 增加 `--no-open`：rc.8 本地 `dsh web` 会自动开系统浏览器；Electron 壳只托管官方 UI，不再弹浏览器。
- 就绪解析忽略 `dsh web: opening the default browser...` 诊断行，只接受 loopback URL。
- 契约快照按 rc.8 重抽；`latest-tested` 改为 `0.1.0-rc.8`。
- 官方 rc.8 SQLite 存储格式不兼容：会话真源仍是官方 `~/.dsh`，社区层不迁移、不自造第二套 session。
- TUI 官方 peer（`dsh-llm` / `dsh-session` / `dsh-agent`）对齐同一 pin。
- Node 下限 `>=22.15.0`：官方 `dsh-session-persistence-jsonl` 使用 `node:zlib` zstd；22.14 上 `dsh web` 会在就绪前退出。

- 输入系统重写:移除 ink-text-input,自研按键处理(兼容 cooked/raw 模式整行输入)
- 修复:交互键入消息(含中文)未渲染——user/message 形状适配 + runtime-context 快照过滤
- 修复:draft 状态移入 store,消除 useInput 闭包状态丢失(修复 /help 与审批 y/n 失效)
- 审批弹窗真实端到端验证:官方沙箱升级 → 弹窗 → y 放行 → 工作区外文件写入成功

- 界面打磨：思考折叠(Tab 展开/收起)、/help 帮助面板、/exit 提示
- 文档对齐：apps/tui README 与 docs/tui-adapter.md 反映自研终端面架构(官方工具启用、0 禁用、KPI 表)

- TUI Ownership Closure 收尾：移除 preset-isolation 禁用层，官方工具(bash/fs 等)全部启用，执行与审批走官方瀑布；自研 UI 只做展示与交互
- 真实 key 端到端验证：对话流(助手/思考/回复)、工具调用(tool 卡片 + 文件真实落地)全部通过
- patch-surface KPI 更新：0 处工具禁用、6 处自有配置行、1 处自研 insert

- TUI Ownership Closure：终端自研 `@dsh-community/tui`（官方 seam：ctx.agents / session/event / userQuestions / approval），彻底移除第三方 TUI 挂载；第三方只许参考，CI 强制（third-party-surface 守卫）

## 0.1.6 — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.6

社区产品号统一为 **0.1.6**。根目录、Desktop、TUI 和 workspace 包同一数字。官方 Runtime 仍是 `@deepseek-ai/dsh@0.1.0-rc.6`，那是上游 pin，不是我们的版本。

- 官方 runtime 暂存**重写为纯 npm 经典 node_modules**：无符号链接、无虚拟店，Node 解压即可解析；安装时运行 postinstall，Linux 上 node-pty 原生编译，win/mac 用官方 prebuild
- 暂存自检：`@deepseek-ai/dsh-app-boot` / `commander` 必须能 require.resolve；node-pty 二进制必须存在；tar ≥ 80MB
- 本地全链路实测：首启解压 → 官方 Web 200 → 干净退出 → 二次启动不解压直接 200
- v0.1.3 / v0.1.4 桌面端不可用，保持 Pre-release；v0.1.5 tag 未发布，不要下载

## 0.1.4 — 2026-08-16
- 三个社区端：WSL/Linux Terminal、Windows Desktop、macOS Desktop

## 0.1.5 — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.5

tag 已打，GitHub Release 未发布。此 tag 仍用 v0.1.4 那套 pnpm 虚拟店暂存，不要当正式下载。

- 产品端钉死为三个社区端:WSL/Linux Terminal、Windows Desktop、macOS Desktop。官方 Web 是共享 `~/.dsh` 的官方入口,不是社区端。Linux AppImage 降为次要产物。
- `artifact-smoke` 按三个社区端验 Latest:Windows Setup / macOS dmg / Linux 终端(不是 AppImage)。Windows 静默安装后轮询 exe,不再默认 v0.1.2。
- 打包时官方 runtime tar 小于 80MB 会重打,避免复用残包。
- `pnpm start` / `doctor` / `tui` 会先编 workspace 依赖。干净 clone 后不再因为缺 `dsh-bridge` dist 而 tsc 失败。
- Electron-as-node 回退路径加 `--expose-internals`,避免官方 `cordis-plugin-hmr` 静默中止插件树。
- asar vendor=0 打包后护栏:发布流程打包后断言 asar 不含 `@deepseek-ai` / `node_modules`。

## 0.1.4 — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.4

Windows flatten 必须带上 `.pnpm`。v0.1.3 跳过它之后安装包又缩到 99MB，官方依赖可能不完整。本版解引用拷完整虚拟店，并校验 tar 至少 80MB。

## 0.1.3 — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.3

补丁版。`v0.1.2` 的 tag 曾被挪到只拷官方包本体的 Windows 暂存上，Latest 上的 Setup 一度变成缺依赖的 99MB 包。本版从完整 hoisted 树解引用压平再打包。

- Windows 暂存压平完整官方依赖树，不再只带 `@deepseek-ai/dsh` 本体
- 第一次启动先出加载页再解官方 Runtime；解压写 ready stamp，半截失败会重解
- 已发布 tag 禁止覆盖：publish job 发现 Release 已存在就失败
- 使用指南写明未签名 / SmartScreen / sha256 校验

## 0.1.2 — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.2

第一个三系统 Stable。官方 Runtime 的社区发行版：同一套 `~/.dsh`，Web / Desktop / Terminal 三个入口。v0.1.1 AppImage 里官方 `dsh web` 起不来，本版连同启动修复一起发布。

- Linux AppImage / macOS dmg / Windows NSIS（`DSH Community Setup 0.1.2.exe`），各带 sha256
- 官方 runtime 打成单个 `official-dsh.tar` 放进安装包，第一次启动解到 userData；Windows 不再拷 3 万个小文件
- 统一入口：`dsh-community` / `new` / `resume last` / `sessions` / `doctor` / `version` / `plugins` / `desktop`
- 没密钥打印 doctor 后退出，不闷头进 Ink
- 定位：One Harness. Three Surfaces. 不 patch 官方 UI，注册表是验证层不是目录
- Edition 已归档，下载只走本仓 Releases

Windows 安装包未签名；macOS dmg 未公证。portable zip 还没打。

## 0.1.2-preview — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.2-preview

稳定性修复版。v0.1.1 AppImage 里官方 `dsh web` 经 Electron-as-node 启动时不会绑定端口，桌面无法打开官方 UI；本版修复。

- 打包版优先用系统 Node 启动官方 `dsh web`，Electron-as-node 仅作回退
- 打包版主进程通过 `DSH_COMMUNITY_BIN` 定位暂存的官方包，启动失败不再静默
- 官方 Web 就绪后轮询端口（容忍 502 预热），避免 ERR_CONNECTION_REFUSED；页面加载竞态的 ERR_ABORTED 不再产生未处理 rejection
- 退出时终止插件安装子进程，不再遗留孤儿 pnpm 进程
- `dsh-community-tui --doctor`：自检官方包 / bin / 数据目录 / session 数 / TTY / API 密钥存在性，不启动对话、不打印密钥，密钥缺失时退出码 2
- Desktop 社区市场页支持一键安装 / 卸载：唤起官方 `dsh plugin --profile web add|remove`（不自造安装器），已装状态读官方 profile 的 package.json，完成后提示重启官方运行时生效

## 0.1.1 — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.1

0.1.1 = 0.1.1-preview 之上新增桌面内嵌市场页与壳打磨，注册表同时扩容。

- Desktop 社区市场页（托盘「社区市场」/ Host → Community marketplace）：只读浏览 [dsh-community-plugins](https://github.com/kamanager2012/dsh-community-plugins) 目录，10 分钟在线缓存，抓取失败回退 userData 缓存
- 安装仍走官方 `dsh plugin add <name>` 或 [dsh-marketplace](https://github.com/kamanager2012/dsh-marketplace) CLI；Desktop 不做第二套安装器
- 注册表收录 7 个社区验证插件（dsh-compressor / dsh-context / dsh-lan-access / dsh-memory-vault / dsh-plugin-hello / dsh-rtk-optimizer / dsh-voice），全部在 rc.6 上 `dsh plugin add` 安装 + 合成验证通过
- Desktop settings：hide-to-tray、可选隔离官方数据到 `userData/isolated-dsh`（改动重启 `dsh web`）
- 官方 session 列表显示 mtime，可复制 `dsh-community-tui --resume <id>`
- Host 诊断页；所有壳页面有统一的顶栏导航
- 隔离模式读/拉起 `userData/isolated-dsh`，不再指向 `~/.dsh`
- `dsh-community-tui` 把前置 `--` 当作 pnpm passthrough，`--help` / `--list-sessions` 可用
- 官方 `dsh web` 跑在子视图里，社区 chrome 条保持可见（Session / 设置 / 诊断随时可达）
- `--list-sessions` 在官方路径旁打印 transcript mtime

## 0.1.1-preview — 2026-08-16

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.1-preview

Published only from this repository. Official `@deepseek-ai/dsh@0.1.0-rc.6` is the development foundation.

- Community TUI launcher (`dsh-community-tui`) boots official `dsh --profile dsh-community-tui`
- `--list-sessions` / `--resume <id>` read and validate official `~/.dsh/sessions`
- `--resume` is forwarded as official app args (`dsh --profile … --resume <id>`)
- Desktop Host menu lists the same official session store
- TUI patch surface stays at 8 owned rows (reference TUI bundle is 33)
- Do not npm-publish workspace packages; do not use the `dsh-tui` binary name

## 0.1.0-preview — 2026-08-15

Release: https://github.com/kamanager2012/dsh-community/releases/tag/v0.1.0-preview

First public-shaped preview. Not a replacement for official DSH, dsh-TUI, or the third-party Desktop installers.

- Thin Electron shell that spawns published `@deepseek-ai/dsh@0.1.0-rc.6` (`dsh web`)
- Official `~/.dsh` is the default session store
- Lifecycle-only IPC; stdout is diagnostics
- Contract snapshots of official CLI / config rows / session-agent-approval-plugin surfaces
- Desktop-owned Version Manager reads `latest-tested`; does not switch official artifacts yet
- TUI work is a seam + patch-surface KPI. Ink stays a mounted plugin, not a vendored fork
