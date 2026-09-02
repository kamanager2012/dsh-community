# Android 第五社区端点（移动端）

> 状态：`[LABS]` / `[UNVERIFIED]`。Android 仍是第五社区端点，但目标已从 embedded local runtime 转为轻量 Remote Client；在 Remote Android Acceptance 通过前不承诺已发布能力。

[English](android-endpoint.en.md) · [Runtime Substrate](android-runtime-substrate.md) · [Reality Gate](reality-gate.md)

## 定位

Android 是 DSH Community 的**第五个社区端点**（前四个为 WSL/Linux 终端、Windows Desktop、macOS Desktop、Linux AppImage）。Android 源码属于本仓主线，但当前尚未进入 Published Latest。目标形态改为 APK Remote Client：官方 `@deepseek-ai/dsh` 只运行在可信 Host，Android 仅负责 Session / Prompt / 事件流 / 审批 / 问答交互，不携带 Node、Agent loop、Session store 或 tool executor。完整边界见 [Remote Host-Client Architecture](remote-host-client.md)。

## 目标架构

```text
Official DSH Host
    ↓ verified public seams
Remote Host Adapter
    ↓ Noise IK E2EE
LAN → WebRTC P2P → blind WS Relay
    ↓
Android Remote Client
```

Host 是唯一执行与状态中心；Android 是轻量交互终端。旧 Node/substrate/PTY/sandbox/ripgrep Reality Gate 仅作为 embedded-runtime **历史迁移证据**保留，Remote 路径接受后再独立归档/删除。

## Legacy embedded-runtime evidence

## 已知风险(2026-08-17 事实)

| 项 | 事实 | 处置 |
| --- | --- | --- |
| Node 引擎要求 | 官方要求 `^22.19.0 \|\| >=24.0.0`；截至 2026-09-02，stock nodejs-mobile 最新 Android release 为 Node 18.20.4 | **硬阻断**：不能用 stock nodejs-mobile 冒充兼容 substrate；先解决 Node 22.19+ Android runtime |
| 原生模块 `sharp` | 仅 `attachment-local` 插件使用,无安卓预编译二进制 | 移动端禁用附件/图像插件,或用 NDK 交叉编译后列入验证注册表 |
| Gradle 接线 | 历史 Labs 使用 `com.github.nodejs-mobile` 插件声明，但当前未建立可验证的现代 Gradle 集成证据 | 已从活跃 Gradle 配置移除；不把未验证插件当成可构建证据 |
| 后台保活 | 系统会杀后台进程 | Foreground Service + 常驻通知(兼任审批入口) |
| 上架渠道 | Play 对"可执行任意插件代码"审查严格 | 沿用 GitHub Releases 直发 APK + digest,不走 Play |

## Reality Gate 门禁(Android 专属)

```text
兼容 Node 22.19+ Android substrate 有可复现来源/构建
  → Termux 真机验证(scripts/termux-verify.sh 通过)
  → official @deepseek-ai/dsh@0.1.2-alpha.4 在 Android substrate 启动
  → embedded runtime E2E
  → APK 契约测试
  → arm64 真机 + x86_64 模拟器 smoke
  → 发布证据
```

未通过前保持 `[UNVERIFIED]`。验证结果必须引用 `$HOME/.dsh/termux-verify.log` 的真实输出,不接受"应该能跑"。

## 验证入口

```bash
# Termux 内
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community && bash scripts/termux-verify.sh
```

## 机器状态

当前门禁见 [`apps/android/runtime-substrate.json`](../apps/android/runtime-substrate.json)。只有该状态从 `BLOCKED` 经真实证据升级后，才允许把 Android 描述为可运行 APK。
