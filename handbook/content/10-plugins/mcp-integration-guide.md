# Model Context Protocol (MCP) 与 DSH 插件集成实战指南

> ⚡ **开放协议无缝对接**：如何将开源社区的标准 MCP (Model Context Protocol) 工具快速接入官方 DeepSeek Harness 运行时。
>
> Marketplace CLI 真源在 [`dsh-community/packages/marketplace`](https://github.com/kamanager2012/dsh-community/tree/main/packages/marketplace)。下面命令里的 `dsh-marketplace` 也可以写成产品仓里的 `pnpm marketplace -- …`。

---

## 1. 为什么在 DSH 中使用 MCP？

在 2026 年，Anthropic 倡导的 **Model Context Protocol (MCP)** 已经成为行业事实上的统一工具与上下文连接协议。通过 MCP，你可以直接将以下生态工具零成本挂载到 DeepSeek Harness：
* **数据库操作**（SQLite、PostgreSQL、MySQL、Redis）
* **本地与远程文件系统**（Filesystem MCP Server）
* **API 与开发者工具**（GitHub、GitLab、Sentry、Puppeteer 网页抓取）

---

## 2. 架构原理 (Adapter Architecture)

```text
官方 DeepSeek Harness (DSH Runtime)
                  │
                  ▼
   dsh-marketplace (mcp-wrap)
                  │
                  ▼
  [ DSH MCP Bridge Adapter (stdio / sse) ]
                  │
                  ▼
   标准外部 MCP Server (如 @modelcontextprotocol/server-sqlite)
```

DSH 社区版通过 **Anti-Corruption Layer (防腐层)** 将标准 MCP 的 `tools/list` 与 `tools/call` JSON-RPC 协议无损映射为 DSH 插件的执行生命周期。

---

## 3. 一键包装与接入实战

### 第一步：使用 `dsh-marketplace` 快速生成适配定义

在终端中执行 `mcp-wrap` 命令：

```bash
# 包装一个 SQLite MCP 工具
dsh-marketplace mcp-wrap sqlite-tool npx -y @modelcontextprotocol/server-sqlite /path/to/db.sqlite
```

生成的插件配置示例：
```json
{
  "name": "dsh-mcp-sqlite-tool",
  "version": "0.1.0",
  "type": "mcp-adapter",
  "entrypoint": "dist/adapter.js",
  "mcpConfig": {
    "name": "sqlite-tool",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-sqlite", "/path/to/db.sqlite"],
    "transport": "stdio"
  }
}
```

---

## 4. 插件安装前的安全静态审查 (Audit)

为了防止恶意插件滥用权限，在安装前可运行 `dsh-marketplace audit` 进行静态扫描：

```bash
dsh-marketplace audit @dsh/plugin-name
```

审查维度：
* **`shell:exec`**：是否声明任意终端/子进程执行权限；
* **`fs:destructive`**：是否包含文件删除与覆盖操作；
* **`net:egress`**：是否存在未经声明的外部网络外联。
