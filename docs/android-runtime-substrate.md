# Android 本地 Runtime Substrate 决策

> 状态：**BLOCKED / candidate identified**。Android 仍是活跃的第五个 Community endpoint；本页只定义本地官方 DSH Runtime 的底层可运行条件，不把未通过的实验写成产品能力。

## 结论

当前不再把 stock `nodejs-mobile` 当作可行的 alpha.4 substrate。

原因是版本约束直接冲突：

- official `@deepseek-ai/dsh@0.1.2-alpha.4`：Node `^22.19.0 || >=24.0.0`
- stock nodejs-mobile 最新 Android release（2026-09-02 核验）：Node `18.20.4`

新的首选候选是：

> **从官方 Node.js `v22.19.0` 源码使用其自带 Android NDK 交叉编译入口构建 Android carrier。**

该候选已经钉死到 Git 身份，而不是只看版本字符串：

- verified annotated tag object: `a9d4750074c7b5439c61daa28ea9afb5dc28e43e`
- tag 指向 commit: `f8fe6858549f75a4b4e9633abf39dd2038dbf496`
- probe 要求本地 `refs/tags/v22.19.0`、tag commit、HEAD 三者全部与上述对象一致，并拒绝 tracked source 修改。

Node 官方 `v22.19.0` 的 `BUILDING.md` 与 `android_configure.py` 仍保留 Android 交叉编译路径，但同时明确声明 **Android is not a supported platform**，且官方 CI 不覆盖 Android。因此它只是我们可以自行验证的源码路径，不是上游支持承诺。

## 为什么 Node 22 仍然不是终点

即使 carrier 本身在 Android 上执行成功，完整 DSH 仍有第二层 native closure：

| DSH surface | Native dependency | 当前裁决 |
|---|---|---|
| `dsh-subprocess-local` | `node-pty`, `koffi` | **HARD blocker** |
| `dsh-attachment-local` | `sharp` | **HARD blocker** |
| `dsh-sandbox-local` | Landlock launcher / Windows ACL backend | **HARD blocker** |
| `dsh-tool-fs-search` | `@vscode/ripgrep` binary | feature blocker |

因此：

```text
Node 22 Android carrier PASS
        ≠
Full DSH Web PASS
```

官方 `sdk-minimal` 也不是现成逃生路线：它虽然不继承 `dsh-base`，但仍显式挂载 `dsh-subprocess-local`、`dsh-sandbox-local` 和 persistent terminal stack。

机器清单见：

- `apps/android/runtime-substrate.json`
- `apps/android/native-blockers.json`

## Reality Gate

### G0 — 官方 CLI 安装闭包

先运行：

```bash
node scripts/audit-android-official-cli-closure.mjs
```

当前预期输出是：

```text
status = BLOCKED_BY_NATIVE_CLOSURE
profileOnlyMitigation = INEFFECTIVE
```

原因不是某个 profile 配置写错，而是当前发布的顶层
`@deepseek-ai/dsh@0.1.2-alpha.4` **在 npm 包依赖层就直接携带**
`dsh-base`、`sdk-minimal`、`tool-fs-search` 等；其中 `dsh-base` 又依赖
`subprocess-local`、`attachment-local`、`sandbox-local`、`tool-fs-search`。
因此把 Cordis row 设成 `disabled` 只能改变运行期 composition，不能从安装闭包中删除
`node-pty` / `koffi` / `sharp` / sandbox native backend / packaged ripgrep。

这把路线收敛为三个选择：

1. **优先路线：**继续使用顶层官方 `@deepseek-ai/dsh`，为其 native closure 做 Android 兼容/交叉构建并逐项过 Reality Gate。
2. **上游路线：**如果官方未来把 CLI/bundle/native packages 拆成 Android-safe 可选依赖，重新抽取 contract 后再裁决。
3. **不自动采用：**绕开顶层 `@deepseek-ai/dsh`、只拼底层官方模块。虽然模块仍来自官方，但这会改变“发布版官方 CLI 是 Runtime 真源”的产品边界，必须单独架构评审，不能偷偷当成优化。

G0 未解决时，所谓“精简 Android profile 已解决兼容性”一律判无效。

### G1 — Node carrier

手工执行：

```bash
NODE_SOURCE_DIR=/abs/node-v22.19.0 \
ANDROID_NDK_HOME=/abs/android-ndk \
bash scripts/android-node22-probe.sh verify
```

必须同时证明：

1. 使用的源码精确匹配 `v22.19.0` verified tag object 与 commit，不接受“同版本号的其他源码”
2. 通过官方 Node Android configure path 完成交叉编译
3. 目标 carrier 在真实 Android 设备上可执行
4. 设备输出 `process.versions.node === "22.19.0"`
5. 设备输出 `process.platform === "android"`

未完成 G1 前，`runtime-substrate.json.status` 继续是 `BLOCKED`。

### Release fail-closed

Android 发布资格不是人工口头判断。运行：

```bash
node scripts/verify-android-release-ready.mjs
```

当前必须返回非零并打印 `android-release-ready: BLOCKED`。只有以下证据同时成立才允许 PASS：

- runtime substrate / carrier = `PASS`
- release target native closure = `PASS`
- 所有 native blocker = `RESOLVED`
- real-device Reality Gate = `PASS`
- Node carrier 有 SHA-256 + 真机执行证据
- official DSH boot = `PASS`
- arm64 真机 APK smoke + x86_64 emulator smoke = `PASS`
- APK SHA-256 存在
- App 内 `RUNTIME_SUBSTRATE_READY` 已由证据驱动升级

当前空证据文件是 `apps/android/evidence/reality-gate.json`，状态固定为 `NOT_RUN`；不能凭文档或代码存在性推断通过。

### G2 — Native closure

逐项裁决 `native-blockers.json`：

- 找到 Android 原生实现；或
- 用官方 DSH profile/composition 明确移除该能力；或
- 上游官方增加 Android 支持。

不能通过“模块大概不会被用到”升级证据等级。

### G2 — Native addon 与 Android 语义分离验证

G2 现在拆成两层，不能再用一个“native build 成功”概括。

机器真源：

- `apps/android/native-compatibility.json`
- portable dependency audit：`scripts/audit-android-portable-deps.mjs`
- 手工 probe：`scripts/android-native-addon-probe.sh`

#### G2-A：原始 frozen addon build/load

调用方先通过 G1，然后提供：

- committed alpha.4 runtime lock 生成的 classic `node_modules` staging tree
- 精确 Node `v22.19.0` source/build
- Android NDK
- 真机 adb（device/verify 模式）

运行：

```bash
RUNTIME_DIR=/abs/runtime-stage \
NODE_SOURCE_DIR=/abs/node-v22.19.0 \
ANDROID_NDK_HOME=/abs/android-ndk \
bash scripts/android-native-addon-probe.sh verify
```

probe 不下载依赖，也不修改上游源码：

- `node-pty@1.2.0-beta.15`：沿 Node 官方 Android GYP/NDK 环境原样 source rebuild；当前精确 upstream tag commit 为 `8f218f6c194be81d98b1eeea344b150e83445824`。
- `koffi@3.1.6`：使用 frozen npm 包内原始 CMake source + Android NDK toolchain 构建，不给 Koffi 源码打补丁。
- 真机分别执行 Koffi `getpid()` FFI smoke、node-pty `/system/bin/sh` PTY smoke，以及 frozen `sharp@0.35.4` → `@img/sharp-wasm32@0.35.4` 的 2×2 PNG 生成 smoke。
- sharp 的 WASM 包必须来自 frozen runtime staging；若 host-specific `npm ci` 没有实际物化该 optional package，probe 会明确报 `sharp WASM materialization gap`，不会把“lock 中存在”冒充“APK 已带 bytes”。

这里故意不预先修 `-lutil`、Bionic、N-API/linker 等问题；如果 unmodified build 失败，真实错误就是下一轮兼容补丁的证据。

#### G2-B：addon 能 load 仍不等于官方 DSH 可运行

即使 G2-A PASS，以下仍是独立硬门：

1. **Terminal inspector**：alpha.4 `createProcessInspector()` 只接受 `linux / darwin / win32`。Node Android carrier 的 `process.platform` 是 `android`，所以 terminal inspection 需要上游 Android 分支或经正式架构评审的官方 seam adapter。
2. **Sandbox**：`dsh-sandbox-local` 的 `PLATFORM_CHAINS` 同样没有 Android，未识别平台按设计 fail closed。需要 Android runner/上游支持，并且必须在 APK app UID 下测内核与权限能力。
3. **POSIX hard-link durable publish**：alpha.4 session persistence 和 attachment store 在非 win32 路径仍使用 `link()`。必须在 APK 私有文件目录验证；`/data/local/tmp`、Termux home 或其他 shell UID 结果不能代替。
4. **sharp**：frozen lock 已精确包含 `sharp@0.35.4`、`@img/sharp-wasm32@0.35.4` 与 `@emnapi/runtime@1.11.3`，都有 registry provenance + SHA-512；sharp loader 在 Android native platform miss 后会尝试 WASM fallback。当前剩余门是 optional bytes 是否被实际 materialize，以及 Android carrier 上真实 PNG smoke 是否 PASS。
5. **ripgrep**：`@vscode/ripgrep@1.18.0` 会硬解析 `@vscode/ripgrep-${process.platform}-${arch}`，Android 对应 package 并不存在；DSH 的 sidecar 只在 `'pkg' in process` 时启用。仅交叉编一个 `rg` binary 还不够，必须有上游 Android package 或正式 rg-path seam。Community 不伪造 `@vscode` scope、不 spoof `process.pkg`、不依赖 Termux/system `rg`、不替换成未钉版本的新版。
6. **ripgrep provenance**：wrapper 1.18.0 对应 Microsoft `ripgrep-prebuilt v15.0.1`；其配置固定 BurntSushi/ripgrep `15.0.0` + Microsoft patch。任何未来 Android binary 必须保持这一 provenance 或经新的上游版本评审，不能只拿 vanilla/latest `rg`。

所以当前 G2 仍是 **BLOCKED**，只是 blocker 已经从“泛泛 native 不支持”缩成可逐项验证的工程门。

### G3 — Official DSH boot

必须在 Android carrier 上实际启动：

```text
official @deepseek-ai/dsh@0.1.2-alpha.4
→ selected official composition
→ session create
→ model turn
→ clean shutdown
```

这里仍坚持：

- Agent loop：官方
- Session：官方
- Tool execution：官方
- Approval / sandbox：官方 seam

Community 只允许拥有 Android packaging、carrier、profile selection、生命周期和证据。

### G4 — APK integration

只有 G1–G3 通过后才接：

```text
APK
→ native carrier
→ official DSH
→ loopback 127.0.0.1
→ official Web UI
```

然后再做 arm64 真机、x86_64 emulator、后台生命周期、功耗与恢复测试。

## 明确不做

- 不因为 stock nodejs-mobile 落后就删除 Android Local
- 不用 Remote Client 取代 Local endpoint
- 不引入 Codex
- 不 fork DeepSeek Agent loop
- 不恢复 Archived Suite 的第二套 runtime-client / Session store
- 不在没有真机证据时发布 APK
