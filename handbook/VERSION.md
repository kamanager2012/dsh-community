# 版本与兼容性

DeepSeek Harness 仍处于 Developer Preview，命令、配置字段和插件接口可能随版本变化。本手册提供使用路径和安全边界；实际运行时以已安装版本的 `--help` 和上游文档为准。当前 Community 版本事实快照为 2026-08-21。

## 手册定位

本手册面向需要把 dsh 放进真实工程流程的个人和团队，重点是实施、权限边界、结果验收、失败恢复、自动化和长期运维。它不是泛泛的 AI 编程教程，也不把示例模板或未运行的命令包装成实验结论。

## 运行时要求

- Web UI 和 CLI：Node.js 22.19+ 或 24+。
- Python SDK：Python 3.10+、Git，以及隔离的 workspace。
- Python SDK 官方支持的主要平台：Linux x64、Linux arm64 和 macOS 14+ arm64。
- 已发布的 Python SDK runtime 不要求系统 Node.js；从源码构建时另按源码仓库的开发要求操作。

## 使用前检查

```bash
node --version
npx @deepseek-ai/dsh --help
npx @deepseek-ai/dsh web --help
```

需要可重复部署时，固定 `@deepseek-ai/dsh` 的具体 npm 版本；Community 当前内核 pin 见 [`current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json)，并在升级后重新检查：

- Web/CLI 参数和 profile；
- Provider 字段、凭据引用和模型 ID；
- 权限、沙箱和网络边界；
- Python SDK 的安装版本和返回字段。

源码仓库的开发环境要求也可能不同于 npm 发布包；不要把源码 `package.json` 的版本号直接当成 npm 包版本。

Community 发行版的版本规则见 [`dsh-community` version policy](https://github.com/kamanager2012/dsh-community/blob/main/docs/version-policy.md)。当前 Latest / 内核 pin 以 [`current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json) 为准，本手册不另造一份。

## 官方资料

- [官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [官方 Web UI 中文指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.zh.md)
- [官方 Provider 中文指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.zh.md)
- [官方 Python SDK 中文指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.zh.md)
- [官方 CLI 中文参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.zh.md)
- [官方开发指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/development.md)

仓库中的 `evidence/` 和 `labs/` 是维护者附录，不是版本兼容性的必要阅读路径。
