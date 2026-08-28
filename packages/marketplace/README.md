# @dsh-community/marketplace

社区插件发现 CLI。目录是本包 [`catalog.json`](catalog.json)，安装仍走官方 `dsh plugin add`。

以前是独立仓库 `kamanager2012/dsh-marketplace`，现已并入本仓。独立注册表 `dsh-community-plugins` 同样已并入，只留跳转。

```sh
pnpm --filter @dsh-community/marketplace build
pnpm --filter @dsh-community/marketplace start list
# 或根目录：
pnpm marketplace -- list
```

高风险插件（注册表 `requiresConfirmation` 或 `risk` 非 `low`）需要 `--yes`。用法见 [docs/usage.md](docs/usage.md)。
