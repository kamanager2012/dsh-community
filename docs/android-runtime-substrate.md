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
