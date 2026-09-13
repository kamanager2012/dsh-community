# Glossary

| Term | Meaning |
| --- | --- |
| Agent | The execution subject that receives input, requests models, calls tools, and advances a task inside a session |
| Agent loop | The cycle that processes input, model responses, tool results, and the next action |
| bundle | A distributable composition of configuration and mounted code |
| cwd | The process or agent's current working directory |
| Cordis | The plugin framework underneath dsh |
| DSH_HOME | The directory that stores dsh user configuration, credentials, profiles, and state |
| Provider | A configuration object that connects a model, protocol, endpoint, and credentials |
| profile | A named runtime composition |
| patch | An override that replaces or inserts nodes in the plugin configuration tree |
| workspace | The project directory used as the agent's task filesystem |
| session | The boundary for conversation events, history, model, state, and recovery |
| turn | One cycle from accepting input to having no pending work |
| step | One model request and its chain of tool calls |
| tool schema | The structure that declares a tool's name, description, and parameters to the model |
| headless | A CLI profile that runs one agent task without starting a Web server |
| history | A view read from persisted events |
| resume | Continuing or recovering work in the same session |
| fork | Creating a child session from a completed boundary of a parent session |
| MCP | A protocol/integration pattern for providing external tools or resources to an agent |
| PTY | A pseudo-terminal used for persistent shells or interactive processes |
| sandbox | A mechanism that limits process access, writes, network, or execution |
| approval | A person's permission requested before a high-impact action |
| DSH permission mode | A dsh preset or policy for read/write, command, and tool requests |
| finish_reason | The reason an agent run ended |
| JSONL | A format with one JSON object per line |
| seam | An extension boundary made of replaceable capabilities, providers, and consumers |
| service | A capability exposed in the Cordis context for other plugins to use |
| disposer | Cleanup logic that undoes registrations and closes resources when a plugin unloads |

Exact fields and APIs depend on the installed version. Follow current upstream
documentation and command help for implementation details.
