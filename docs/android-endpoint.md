# Android 第三互补社区端点（移动端）

> 状态：`[LABS]` / `[UNVERIFIED]`。在互补版定位下，Android 是 **三个互补社区端点** 之一（继 WSL/Linux 终端与 Linux AppImage 之后）。R5 已完成架构迁移：移除全部嵌入式 Node.js 与 `@deepseek-ai/dsh` 打包，Android 成为纯轻量 **Remote Client**；在 R6 真机端到端验收（Remote Android Acceptance）通过前不进入 Published Latest。

[English](android-endpoint.en.md) · [Historical Runtime Substrate Note](android-runtime-substrate.md) · [Remote Host-Client Architecture](remote-host-client.md)

## 定位与边界

- Android 是 DSH Community 互补版的**第三个社区端点**（前两个为 WSL/Linux 终端与 Linux AppImage；Windows Desktop、macOS Desktop 与 Official Web 由官方上游 `deepseek-harness` 提供）。
- 官方 `@deepseek-ai/dsh` 只运行在可信 Host；Android 仅通过 `@dsh-community/remote-adapter` 投射官方 Session 列表、Live Event 流、Follow-up Prompt、工具审批（Approval）与问答（Question）。
- APK 内**不得**包含 Node runtime（如 `nodejs-mobile`、`libnode.so`）或官方 `@deepseek-ai/dsh*` 包，也不得在本地维护第二套 Agent loop 或 Session store。

## R5 架构与模块

```text
Official DSH Host
    ↓ verified public seams
Remote Host Adapter
    ↓ Noise_IK_25519_ChaChaPoly_BLAKE2b E2EE
LAN WebSocket → WebRTC DataChannel seam → Blind WebSocket Relay
    ↓
Android Remote Client (Kotlin, noBackupFilesDir + Android Keystore AES-256-GCM)
```

- **密钥与安全基线**：`DeviceIdentityStore.kt` 使用 Android Keystore AES-256-GCM 主密钥（优先 StrongBox，回退 TEE）封装设备 Curve25519 密钥于 `noBackupFilesDir`，Manifest 强制 `android:allowBackup="false"`。
- **密码学与协议**：纯 Kotlin 实现 `Noise_IK_25519_ChaChaPoly_BLAKE2b`，支持单调递增 `connectionEpoch` 校验、`session.attach(afterSeq)` 断点续传与幂等键（`idempotencyKey`）。
- **容灾切换与后台保活**：`FailoverRemoteSession.kt` 按 `LAN -> WebRTC -> Relay` 顺序回退（`AndroidWebRtcPeerEngine.kt` 基于 `io.github.webrtc-sdk:android` 实现 Noise IK over DataChannel）；`RemoteSessionService.kt` 作为 `dataSync` 前台服务承载常驻状态通知（支持 Android 13+ 运行时 `POST_NOTIFICATIONS` 请求与处理后自动消隐审批通知），并遵循网络丢失暂停与指数退避策略。
- **实体机与桌面联动配对体验**：`MainActivity` 支持 `dsh-remote://pair` Deep-Link（`ACTION_VIEW`）、系统分享（`ACTION_SEND` `text/plain`）以及一键 **Paste** 剪贴板提取配对；宿主机端 `dsh-community remote start --qr` / 交互命令 `qr` 可直接在终端打印标准 ISO/IEC 18004 半块 UTF-8 二维码。
- **历史实验清理（按 §13 执行）**：原 R0–R4 嵌入式 Node 22 / `node-pty` / Koffi / Landlock / sharp-WASM / ripgrep / `nodejs-project` 阻塞实验已在 R5 PR 中由显式 Remote Client 测试替代并移除（保留于 Git 提交历史）。

## 发布门禁与 CI 验证

- GitHub Actions：`.github/workflows/android-remote-acceptance.yml` 运行纯 JVM 单测、实时 Kotlin-to-Node `RemoteHostRuntime` 互操作测试、Release R8 ProGuard 混淆构建、APK ZIP 清单洁净检查（严禁 `libnode.so` / `nodejs-mobile` / `deepseek-ai`），以及 KVM Android API 34 (`x86_64`) 模拟器端到端 R6 验收（含 `Dead-LAN -> WebRTC P2P` 与 `Dead-LAN -> Blind Relay` E2EE 容灾、`AndroidKeyStore` 加密持久化及设备吊销）。
- 机器门禁状态：[`apps/android/evidence/reality-gate.json`](../apps/android/evidence/reality-gate.json)（`schemaVersion: 2`, `architecture: "remote-only"`, `status: "NOT_RUN"`, `arm64RealDeviceSmoke: false`）。
- 发布阻塞检查：`node scripts/verify-android-release-ready.mjs` 保持 fail-closed（退出码 `1`），直至 R6 真机（物理 `arm64-v8a`）硬件验收完成并显式晋升前，Android 保持 `[UNVERIFIED]`。
