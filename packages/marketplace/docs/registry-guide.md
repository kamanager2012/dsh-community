# 插件注册表与验证指南

[English](registry-guide.en.md) · [返回中文 README](../README.md) · [在线 Handbook](https://kamanager2012.github.io/deepseek-harness-handbook/)

## 这份目录负责什么

`packages/marketplace/catalog.json` 是公开的 Compatibility Registry。它记录插件从哪里来、哪个版本被哪个官方 DSH Runtime 验证过，以及用户在 Marketplace 中应该看到什么状态。

它不负责：

- 执行 Agent 或实现 Runtime；
- 替代官方 `dsh plugin add` 安装链；
- 把作者 README 当成安全或兼容性证明；
- 保存用户 Session、凭据或插件运行数据。

## 条目结构

`catalog.json` 中的条目至少应提供：

| 字段 | 要求 |
| --- | --- |
| `name` | 可由官方 `dsh plugin add <name>` 解析的包名 |
| `description` | 简短、可核对、不夸大结果的描述 |
| `author` | 作者或组织 |
| `repo` | 公开源码 URL |
| `category` | `ui`、`tool`、`provider`、`workflow` 或 `other` |
| `versions[].version` | 被验证的插件版本 |
| `versions[].testedDsh` | 实际使用的官方 Runtime 版本线 |
| `versions[].notes` | 安装、组合或运行 smoke test 的事实说明 |
| `versions[].security` | 结构化安全元数据，见下节「安全元数据」 |

`testedDsh` 是证据关联，不是“永远兼容”承诺。没有匹配当前 Runtime 的版本必须显示 `[UNVERIFIED]`。

## 安全元数据

`versions[].security` 对每个已收录版本给出结构化的权限披露，取代仅凭 README 或作者自述判断插件是否安全。`scripts/verify.mjs` 会校验其结构，缺失或格式错误会让 CI 失败。字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `network` | string | 插件会发起或监听的网络行为；没有则写“无” |
| `dataEgress` | string | 哪些数据会离开本机、发往何处 |
| `credentials` | string | 插件访问、存储或要求提供的凭据/密钥 |
| `filesystem` | string | 插件自身安装目录之外的文件读写范围 |
| `processExecution` | string | 是否派生子进程、调用外部二进制，或拦截/改写其他工具调用 |
| `persistence` | string | 状态在重启或跨会话之间保存在何处 |
| `risk` | `"low"` \| `"medium"` \| `"high"` | 综合风险等级 |
| `requiresConfirmation` | boolean | 安装前是否应向用户显式确认；`risk` 非 `low` 时必须为 `true`（CI 强制） |
| `manualReviewStatus` | `"unreviewed"` \| `"partial"` \| `"reviewed"` | 人工核实这份安全披露本身的程度；**这是对披露内容的核实状态，不是对插件本身运行安全性的独立动态测试**，与顶层的 `[VERIFIED]`/`[PARTIAL]`/`[UNVERIFIED]` 兼容性状态是两套不同的评估维度 |
| `manualReviewNote` | string | 支撑以上判断的具体证据来源（例如引用了作者 README 的哪段自述） |
| `lastReviewedAt` | string (`YYYY-MM-DD`) | 本条安全元数据最后核实的日期 |

对 `network`/`dataEgress`/`credentials`/`filesystem`/`processExecution`/`persistence` 六个描述字段，找不到对应行为时应明确写“无”，不要留空——空字符串会被 CI 拒绝，因为“没写”和“核实过、确实没有”是两件不同的事。

新增或更新条目时，`security` 的内容应来自对该插件源码或 README 的实际阅读，而不是猜测；如果拿不到足够信息判断某个维度，`manualReviewStatus` 应保持 `unreviewed` 并在 `manualReviewNote` 里说明还缺什么证据，而不是编造一个看起来合理的描述。

## 验证阶梯

```text
existence
  → install
  → compose
  → runtime smoke
  → package digest
  → provenance
  → DSH compatibility matrix
```

当前只做到某一级，就只声明到某一级。目录数量不能替代验证深度；尤其不能把“能访问 GitHub”或“README 写了支持”写成运行成功。

建议每个条目保留以下证据：

- 包名和公开仓库仍然存在；
- 使用指定 Runtime 版本完成官方安装；
- 与基础 profile 组合时没有破坏启动；
- 最小运行 smoke test 的命令、退出码和结果；
- 版本、digest 或 immutable commit；
- 所属 Runtime 线和最后核验日期。

## 提交流程

1. 先在插件自己的仓库准备公开安装说明和最小 smoke test；
2. 在 `catalog.json` 增加记录，保持字段和名称格式一致，并填写 `versions[].security`（见上节，`node scripts/verify.mjs --offline` 会校验其结构）；
3. 在 Pull Request 中附上 Runtime 版本、安装命令和结果；
4. 维护者复核目录内容与安全元数据，不把未验证字段写成保证；
5. Marketplace 读取注册表，安装仍回到官方 `dsh plugin add`。

## 用户看到的状态

| 状态 | 含义 | 安全处理 |
| --- | --- | --- |
| `[VERIFIED]` | 有指定 Runtime 线和相应安装/组合/运行证据 | 仍需用户审查插件权限 |
| `[PARTIAL]` | 只有部分证据，例如安装成功但没有运行 smoke test | 不宣称运行兼容 |
| `[UNVERIFIED]` | 没有匹配 Runtime 线或证据过期 | 默认按未知来源处理 |
| `[INCOMPATIBLE]` | 已知与当前 Runtime 线不兼容 | 不进入默认安装建议 |

这张表描述的是**兼容性**证据，与 `security.manualReviewStatus` 描述的**安全披露核实程度**是两个独立维度：一个 `[VERIFIED]` 的插件仍可能是 `risk: high`；`security` 字段不替用户判断插件是否值得信任，涉及网络、文件、进程、凭据或系统修改的插件，仍必须单独阅读源码和权限说明。

## 生态跳转

- [Canonical Product：dsh-community](https://github.com/kamanager2012/dsh-community)
- [已归档 Labs](https://github.com/kamanager2012/deepseek-harness-suite)（不要从那里安装）
- [Marketplace CLI](../README.md)
- [Handbook 插件章节](https://kamanager2012.github.io/deepseek-harness-handbook/content/10-plugins/)
- [官方 Runtime](https://github.com/deepseek-ai/deepseek-harness)
