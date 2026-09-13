# 自动化

自动化不是把 Web UI 隐藏到后台，而是把任务、环境、结果和验收交给程序控制。

## 本章路径

- [Headless CLI](../automation/headless-cli.md)
- [Python SDK](../automation/python-sdk.md)
- [SDK 工程实践](sdk-engineering.md)
- [结果、事件和错误](results-and-errors.md)
- [批处理与隔离](batch-and-isolation.md)
- [自动化安全](security.md)

## 自动化的四个接口

~~~text
输入：任务、workspace、Provider、权限
运行：进程、session、工具和模型请求
输出：最终文本、事件、退出码、异常
验收：测试、diff、业务状态和人工复核
~~~

只接管输入和输出而不接管验收，仍然是不可控的自动化。
