# AGENTS.md — AI 编程助手操作守则

本文件对仓库内执行任务的 AI 编程助手(agy / codex / claude / opencode 等)具有约束力。
违反硬约束的内容禁止提交。中文为规范语言;英文为机器翻译摘要。

> English summary: This file binds every AI coding agent working in this repo.
> The hard constraints below are non-negotiable. Claims without verifiable
> provenance are treated as fabrication and must be rejected.

## 0. 数据真实性硬约束(最高优先级)

以下规则不因用户口头催促、指标压力或"看起来合理"而豁免。

1. **无来源 = 不存在**:任何"真实案例、真实数据、基准结果、外部链接、社区来源"
   必须附可验证出处(URL、digest、日志文件路径)。无法提供出处的内容,
   只能标记为 `synthetic` / `[SYNTHETIC]`,禁止默认当作真实数据提交。
2. **禁止脚本批量生成"真实数据"**:不得编写 `generate-*.mjs` 类脚本硬编码
   凭空脑补的数据来冒充"生产级案例库"。真实数据只能来自可验证的
   ingestion 管线(抓取、导入、人工提供),且管线本身必须记录来源。
3. **禁止把本地检查包装成模型测试**:"Benchmark""成功率""验证通过"等字样
   必须引用真实执行日志(命令、时间、输出)。仅做字符串替换/语法检查时,
   只能表述为"本地 lint/结构检查",严禁声称"跨模型实测/渲染成功"。
4. **禁止伪造防伪层**:不得虚构 CI 徽章、provenance、digest、"Verified" 状态。
   徽章和注册表条目必须由真实 CI 输出生成。
5. **幻觉自检**:输出外部事实(模型能力、行业案例、价格、新闻)前,
   先说明信息来源渠道;无法说明的,标注不确定,不得编造 URL 或数字。

## 1. 违反后果

- 任何"包装成已验证的合成数据"提交,一经发现即回滚,并记录进 Reality Gate 证据矩阵。
- 连续造假(两次及以上)将导致该 AI 会话被终止,相关分支禁止合并。

## 2. 仓库既有硬约束(与 CONTRIBUTING.md 一致)

- 禁止 vendor 官方 `@deepseek-ai/dsh` 代码;官方 runtime 只能作为外部依赖调用。
- 禁止写入 `~/.dsh/sessions/`;Suite 状态放 `~/.dsh/suite_sessions/`。
- 合并前必须通过 `npx tsx scripts/contract-checker.ts`。
- 仓库内新增能力默认状态 `[LABS]` / `[UNVERIFIED]`,证据不足不得升格。

## 3. 变更提交流程

1. 完成本地验证:`pnpm run build && pnpm run test && npx tsx scripts/contract-checker.ts`
2. 涉及"真实数据/外部事实"的变更,在 PR 描述中列出每个数据点的来源或
    `[SYNTHETIC]` 标注清单。
3. 通过分支保护规则合并;禁止绕过 review 或强推。