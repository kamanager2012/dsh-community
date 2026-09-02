# Android 第五社区端点（移动端）

> 状态：`[UNVERIFIED]`。2026-09-02 已从归档 Labs 恢复到本仓 `apps/android` 活跃主线；在 Android Reality Gate 通过前不承诺已发布能力。

[English](android-endpoint.en.md) · [Runtime Substrate](android-runtime-substrate.md) · [Reality Gate](reality-gate.md)

## 定位

Android 是 DSH Community 的**第五个社区端点**（前四个为 WSL/Linux 终端、Windows Desktop、macOS Desktop、Linux AppImage）。Android 源码属于本仓主线，但当前尚未进入 Published Latest。目标形态仍是 APK：WebView 壳 + 兼容的本地 Node substrate 承载官方 `@deepseek-ai/dsh` runtime；当前 runtime substrate 明确为 `BLOCKED`，不复实现 Agent loop，也不把未接通的 Node runtime 冒充成已完成能力。

## 架构

```text
APK
├── WebView            ← 活跃源码；当前可显示 runtime gate 状态
├── Node substrate     ← BLOCKED；shell probe 与 APK shared carrier 分开验
├── Foreground Service ← gate 未通过时 fail-loud，不伪装 runtime 已启动
└── 验证链             ← runtime-substrate.json + Reality Gate
```

## 已知风险(2026-08-17 事实)

| 项 | 事实 | 处置 |
| --- | --- | --- |
| Node 引擎要求 | 官方要求 `^22.19.0 \|\| >=24.0.0`；截至 2026-09-02，stock nodejs-mobile 最新 Android release 为 Node 18.20.4 | **硬阻断**：不能用 stock nodejs-mobile 冒充兼容 substrate；先解决 Node 22.19+ Android runtime |
| `sharp` | frozen lock 已含 exact `@img/sharp-wasm32@0.35.4` fallback，但 optional bytes 与 Android 真机 PNG smoke 尚未通过 | 不删除官方能力；按 G2 materialization + device probe 验证 |
| Gradle 接线 | 历史 Labs 使用 `com.github.nodejs-mobile` 插件声明，但当前未建立可验证的现代 Gradle 集成证据 | 已从活跃 Gradle 配置移除；不把未验证插件当成可构建证据 |
| 后台保活 | 系统会杀后台进程 | Foreground Service + 常驻通知(兼任审批入口) |
| 上架渠道 | Play 对"可执行任意插件代码"审查严格 | 沿用 GitHub Releases 直发 APK + digest,不走 Play |

## Reality Gate 门禁(Android 专属)

```text
exact Node 22.19.0 source identity
  → G1-Shell: adb-shell executable probe（preliminary / non-release）
  → G1-APK-Build: official Node --shared → libnode.so
  → G1-APK-AppUID: APK native/JNI load under app UID
  → G2 native / PTY / sandbox / hard-link / sharp / fs-search gates
  → official @deepseek-ai/dsh@0.1.2-alpha.4 Web boot on loopback
  → arm64 真机 + x86_64 模拟器 APK smoke
  → evidence-backed release
```

未通过前保持 `[UNVERIFIED]`。adb-shell/Termux 结果只能作为 preliminary evidence，不能替代 APK app-UID/JNI carrier、sandbox、hard-link 或 PTY 证据。

## 验证入口

```bash
# preliminary shell carrier
NODE_SOURCE_DIR=/abs/node-v22.19.0 ANDROID_NDK_HOME=/abs/android-ndk \
  bash scripts/android-node22-probe.sh verify

# APK shared carrier build candidate
NODE_SOURCE_DIR=/abs/node-v22.19.0 ANDROID_NDK_HOME=/abs/android-ndk \
  bash scripts/android-node22-apk-carrier-probe.sh build

# release state remains fail-closed until APK app-UID/JNI + downstream gates have records
node scripts/verify-android-release-ready.mjs
```

## 机器状态

当前门禁见 [`apps/android/runtime-substrate.json`](../apps/android/runtime-substrate.json) 与 [`apps/android/carrier-packaging.json`](../apps/android/carrier-packaging.json)。只有 APK shared carrier、app-UID/JNI 和全部下游 Reality Gate 经真实证据升级后，才允许把 Android 描述为可运行 APK。
