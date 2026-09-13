# DSH-AIOS-WEB-BROWSER-BLOCKED-2026-08-14

这是在 `aios-core` workspace 中执行的浏览器层预检。

## 观察过程

1. 使用 `DSH_PERMISSION_MODE=read-only` 启动固定版本 dsh Web 服务，端口为 `3082`；
2. 服务管理器报告 `Server ready on port 3082`；
3. Python Playwright 尝试启动 headless Chromium；
4. 浏览器启动失败：本地 Chromium executable 不存在；
5. 尝试安装 Chromium 时，Playwright 报告当前 `ubuntu26.04-x64` 不受该版本支持；
6. 测试工具随后停止 dsh Web 服务。

## 结论

这是浏览器工具链阻塞，不是 dsh Web 服务失败。此前的 [`WEB-HTTP-2026-08-14.md`](WEB-HTTP-2026-08-14.md) 已证明根路径返回 `HTTP 200`；本记录不产生 DOM、截图或控件状态证据。

对应 YAML 记录：[`DSH-AIOS-WEB-BROWSER-BLOCKED-2026-08-14.yaml`](DSH-AIOS-WEB-BROWSER-BLOCKED-2026-08-14.yaml)。
