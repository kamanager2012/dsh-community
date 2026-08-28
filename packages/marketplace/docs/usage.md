# dsh-marketplace 使用与数据流

[English](usage.en.md) · [返回中文 README](../README.md) · [在线 Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/)

## 它是什么

`dsh-marketplace` 是插件发现和安装体验：读取 `dsh-community-plugins/catalog.json`，帮助用户搜索和查看兼容性，再把安装动作交给官方 `dsh plugin add`。

它不是 Runtime、不是新的 Package Manager，也不拥有插件注册表或用户 Session。

```text
dsh-community-plugins/catalog.json
              ↓ fetch / parse / classify
        dsh-marketplace
              ↓ official command
        dsh plugin add <name>
```

## 安装

需要 Node.js 22+，并确保官方 `dsh` CLI 在 PATH 中。真源在 `dsh-community`，不要再从独立仓 `npm i -g github:kamanager2012/dsh-marketplace`。

```sh
npm i -g @deepseek-ai/dsh
```

从源码运行：

```sh
git clone https://github.com/kamanager2012/dsh-community
cd dsh-community
pnpm install
pnpm marketplace -- list
```

## 常用命令

```sh
dsh-marketplace list
dsh-marketplace search <keyword>
dsh-marketplace info <package-name>
dsh-marketplace audit <package-name>
dsh-marketplace install [--yes] <package-name>[@version]
```

`list`、`search` 和 `info` 展示的是注册表中的验证线。`info` 还会显示 digest、provenance
和 `security` 披露（如果有）。`install` 会在调用官方安装链前自动比对注册表 digest 与 npm `dist.integrity`：
一致则继续；不一致直接拒绝。`security.requiresConfirmation` 为 true 或 `risk` 不是 `low`
时，非交互环境必须加 `--yes`，否则退出非零。

不要把目录成功当成安全扫描。`audit` 在注册表有 `security` 时打印那份披露；没有时才退回本地启发式。

## 如何解读兼容性

| 标记 | 含义 |
| --- | --- |
| 匹配 `testedDsh` | 注册表有对应 Runtime 线的验证记录 |
| `⚠未验证` / `(未验证)` | 没有匹配验证线、证据过期或只有目录存在性（对应其它仓库文档中的 `[UNVERIFIED]`） |

兼容不等于可信。插件可能读取文件、访问网络、启动进程或修改系统；安装前仍应查看插件源码、权限说明和官方安装输出。

## 出问题时先查什么

1. `node --version` 是否为 22+；
2. `dsh --help` 是否能在当前 shell 找到官方 CLI；
3. 注册表条目的 `testedDsh` 是否匹配当前 Runtime；
4. 官方 `dsh plugin add` 的原始错误，而不是只看 Marketplace 的摘要；
5. 安装是否需要未声明的凭据、网络或系统权限。

不要把 Marketplace 的目录成功、网络请求成功或 README 说法当成插件运行成功。

## 开发和验证

```sh
npm install
npm run typecheck
npm run build
npm test
```

修改注册表字段时，先更新 [dsh-community-plugins](https://github.com/kamanager2012/dsh-community-plugins) 的验证记录，再更新本仓库的展示或解析逻辑。

## 生态入口

- [Canonical Product：dsh-community](https://github.com/kamanager2012/dsh-community)
- [插件注册表](https://github.com/kamanager2012/dsh-community-plugins)
- [Community Labs](https://github.com/kamanager2012/deepseek-harness-suite)
- [Handbook 插件章节](https://kamanager2012.github.io/deepseek-harness-handbook/content/10-plugins/)
- [官方 Runtime](https://github.com/deepseek-ai/deepseek-harness)
