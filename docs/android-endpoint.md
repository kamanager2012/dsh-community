# Android 第五社区端点（移动端）

> 状态：`[UNVERIFIED]`。2026-09-02 已从归档 Labs 恢复到本仓 `apps/android` 活跃主线；在 Android Reality Gate 通过前不承诺已发布能力。

[English](android-endpoint.en.md) · [Reality Gate](reality-gate.md)

## 定位

Android 是 DSH Community 的**第五个社区端点**（前四个为 WSL/Linux 终端、Windows Desktop、macOS Desktop、Linux AppImage）。Android 源码属于本仓主线，但当前尚未进入 Published Latest。产品形态是 APK:WebView 壳 + `nodejs-mobile` 内嵌官方 `@deepseek-ai/dsh` runtime,延续 Community 的 Official-Runtime-Centric 薄壳模式,不复实现 Agent loop。

## 架构

```text
APK
├── WebView            ← 加载本地官方 Web UI(与桌面端同一套)
├── nodejs-mobile      ← 内嵌 Node.js,运行官方 @deepseek-ai/dsh
├── Foreground Service ← runtime 保活 + 审批系统通知
└── 验证链             ← 复用 marketplace / 注册表 digest 校验
```

## 已知风险(2026-08-17 事实)

| 项 | 事实 | 处置 |
| --- | --- | --- |
| Node 引擎要求 | 官方要求 `^22.19.0 \|\| >=24.0.0` | 先跑 `scripts/termux-verify.sh` 确认 Termux 的 nodejs-lts 满足;nodejs-mobile 的 Node 版本是 APK 化前必须重新验证的点 |
| 原生模块 `sharp` | 仅 `attachment-local` 插件使用,无安卓预编译二进制 | 移动端禁用附件/图像插件,或用 NDK 交叉编译后列入验证注册表 |
| 构建链 `esbuild` | 有 android-arm64 预编译 | 无阻碍 |
| 后台保活 | 系统会杀后台进程 | Foreground Service + 常驻通知(兼任审批入口) |
| 上架渠道 | Play 对"可执行任意插件代码"审查严格 | 沿用 GitHub Releases 直发 APK + digest,不走 Play |

## Reality Gate 门禁(Android 专属)

```text
Termux 真机验证(scripts/termux-verify.sh 通过)
  → 官方 runtime 在安卓环境无原生依赖阻断
  → nodejs-mobile 加载 runtime 成功(E2E)
  → APK 契约测试(复用 contracts/tests)
  → 交叉平台 smoke(arm64 + x86_64 模拟器)
  → 注册表 digest + 发布
```

未通过前保持 `[UNVERIFIED]`。验证结果必须引用 `$HOME/.dsh/termux-verify.log` 的真实输出,不接受"应该能跑"。

## 验证入口

```bash
# Termux 内
git clone https://github.com/kamanager2012/dsh-community.git
cd dsh-community && bash scripts/termux-verify.sh
```
