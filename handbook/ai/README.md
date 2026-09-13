# DeepSeek Harness AI 知识包

这里是给 AI 检索和工具调用使用的静态双语知识包，不是第二套事实来源，也不替代实时搜索或当前版本的官方资料。

## 它解决什么问题

普通 Markdown 适合人连续阅读，但 AI 通常只需要某个具体问题的一小段内容。知识包把中文 `content/` 和英文 `en/` 下的正文按 Markdown 的二级标题拆成检索记录，每条记录都带有：

- 稳定的 `id` 和所属文档；
- 主题、章节、类型、关键词和摘要；
- 可直接放进上下文的原文 `content`；
- 原始 Markdown 路径、起止行号和 GitHub 来源链接。
- 英文记录还带有 `translation_of`，指向对应的中文事实来源。

摘要和正文都是从 Markdown 确定性提取的，未使用模型改写。`evidence/` 和 `labs/` 不会进入普通知识包，避免把维护者材料或可选任务误当成通用事实。

## 文件

| 文件 | 用途 |
| --- | --- |
| [manifest.json](manifest.json) | 包信息、来源范围、统计和文件入口 |
| [schema.json](schema.json) | 单条检索记录的 JSON Schema |
| [catalog.jsonl](catalog.jsonl) | 每行一条可检索的主题记录 |
| [catalog.en.jsonl](catalog.en.jsonl) | English edition 的可检索主题记录 |
| [terms.json](terms.json) | 从术语表提取的机器可读定义 |
| [terms.en.json](terms.en.json) | English glossary 的机器可读定义 |
| [query_ai_catalog.py](https://github.com/kamanager2012/deepseek-harness-handbook/blob/main/scripts/query_ai_catalog.py) | 本地查询示例 |

## 给 AI 工具的最小接入方式

直接读取公开的 JSONL 地址：

```text
https://raw.githubusercontent.com/kamanager2012/deepseek-harness-handbook/main/ai/catalog.jsonl
```

English edition：

```text
https://raw.githubusercontent.com/kamanager2012/deepseek-harness-handbook/main/ai/catalog.en.jsonl
```

术语快速入口：

```text
https://raw.githubusercontent.com/kamanager2012/deepseek-harness-handbook/main/ai/terms.json
```

English glossary：

```text
https://raw.githubusercontent.com/kamanager2012/deepseek-harness-handbook/main/ai/terms.en.json
```

读取后按 `title`、`section_title`、`summary`、`keywords` 和 `content` 建立索引；回答时必须保留 `source.url`，并以当前版本官方资料和实际 `--help` 为最终依据。它的优势是把中文解释、工程路径和可追溯正文快速交给工具，不是保证静态记录永远比网上的新资料更新。

## 本地查询

```bash
python3 scripts/query_ai_catalog.py "Provider 配置失败怎么办"
python3 scripts/query_ai_catalog.py "Session 恢复" --limit 3 --full
python3 scripts/query_ai_catalog.py "How do I configure the DeepSeek Provider?" --catalog ai/catalog.en.jsonl
```

输出是 JSON，方便脚本、Agent 或其他检索工具继续处理。

## 更新规则

不要手工修改 `catalog.jsonl`、`catalog.en.jsonl`、`terms*.json` 和 `manifest.json`。修改正文后运行：

```bash
python3 scripts/build_ai_catalog.py
python3 scripts/validate_ai_catalog.py
python3 scripts/build_ai_catalog.py --check
```

当前提供稳定的静态检索包；如果未来出现明确的客户端或团队集成需求，再单独评估服务接口。AI 可以整理索引，不能凭空补写运行事实。
