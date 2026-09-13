# 命令速查

## 版本和帮助

~~~bash
node --version
npm --version
npx @deepseek-ai/dsh --help
npx @deepseek-ai/dsh web --help
npx @deepseek-ai/dsh --profile headless --help
~~~

## Web

~~~bash
npx @deepseek-ai/dsh web
npx @deepseek-ai/dsh web --port 3081
npx @deepseek-ai/dsh --profile web --dump-config
~~~

## Headless

~~~bash
npx @deepseek-ai/dsh --profile headless "任务文本"
~~~

任务文本之前放启动器参数。命令行不要放 API key。

## 源码

~~~bash
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
corepack enable
pnpm install
pnpm run build
pnpm dsh web
~~~

## Python SDK

~~~bash
python -m venv .venv
. .venv/bin/activate
python -m pip install deepseek-harness-sdk
~~~

具体示例以官方 Python SDK 指南和安装包版本为准。

## 工作区验收

~~~bash
git status --short
git diff --stat
git diff --check
~~~

按项目运行测试、构建或类型检查。
