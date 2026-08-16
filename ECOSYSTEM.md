# DeepSeek Harness Community 生态项目统一说明

## Project Handoff / Current Source of Truth

**日期:2026-08-16**

---

## 一、项目到底在做什么

我们不是要复制 DeepSeek Harness,也不是简单给官方项目套一个壳。

核心原则是:

> **官方 DeepSeek Harness Runtime 负责真正的 Agent 执行核心;社区项目围绕官方 Runtime 做发行、兼容、插件、知识、治理、安全和更好的用户体验。**

项目方法论:

> 原版官方能力能直接使用就直接使用;
> 官方能力不足时做社区扩展;
> 第三方项目可以参考架构、交互和方法,但不复制代码和产品;
> 所有功能必须以真实代码和真实运行结果为准,不允许用 README 描述代替实际能力。

最终目标不是搞很多仓库,而是形成一个围绕官方 DeepSeek Harness 的社区发行版。

**角色边界搭出来了 ≠ 生态闭环已经转起来。** 现在产品初期、用户接近 0、Registry 有 9 个第三方插件完成 rc.6 安装/组合验证，Marketplace 的发现/安装 UX 已完成当前一轮验证。不要对外说“完整生态闭环”，也不要和 awesome 列表比插件数量。

真正对用户能感知的差异不是 “Zero Vendoring” 或 “架构更干净”，而是：

```text
Official Web  ↔  Community Desktop  ↔  Community TUI
                    same ~/.dsh
                    same official plugins
```

概括成：**One Harness. Three Surfaces.**

和愿意 `patch-package` 改官方 UI、并把 session 放进 Electron userData 的 Desktop 产品，走的是两条路。对方短期产品速度更快；我们不改官方表面，用外围发行层 / 契约 / 验证插件扩展，长期 drift 成本更低。没有谁天然高级。工程原则不是用户价值。

Registry 的目标是验证层，不是最大目录：能装、能跑、适配当前 pin、申请了什么权限。Awesome 做发现，我们做 trust。

节奏必须双轨，不能等 Win/mac/SDK/手册 100% 再开口：`v0.1.2` 三系统 Stable 已发布，工程继续维护安装证据、上游契约和版本漂移，同时把“社区发行版、同一套会话”讲清楚。

---

## 一·五、我们是什么:Community Distribution,不是 Desktop 壳

项目一句话定位:

> **我们没有再造 DeepSeek Harness。我们在官方 Harness 外面建立一个长期可维护的 Community Distribution:同一套 Runtime、同一套 Session、同一套插件,Web / Desktop / Terminal 三个入口。**

类比:

```text
DeepSeek Harness      = kernel / runtime
DSH Community         = distribution
Desktop / TUI         = surfaces
Registry              = verified packages
Marketplace           = package discovery
Handbook              = docs
Labs                  = unstable / testing
```

对外口号:

> **One Harness. Three Surfaces.**

真正的四层竞争优势(注意:都不是"架构干净"这类工程原则本身,而是它们落成的用户价值):

1. **官方原生兼容** — Official DSH,without locking you into another fork。官方 Runtime、官方 Session、官方插件直接可用,不做 patch-package 改上游表面。
2. **三个界面共享一个世界** — 官方 Web 里开的对话,关掉 Web,用 Community TUI 继续;再开 Desktop,还是同一个会话。Same workspace / same session / same plugins。
3. **Verified Ecosystem** — 不跟 awesome 列表比插件数量(它 3000+ stars,比收录量没有意义)。我们做验证层:哪些插件真的能装、能跑、适配 rc.6、会申请什么权限。Awesome = discovery,Registry = trust,Marketplace = UX。
4. **Upstream resilience** — DeepSeek 明天发 rc.7,我们比你先知道哪些东西坏了。Upstream changes → Contract CI → Compatibility Matrix → Community release。

竞争现实(2026-08-16,如实记录,不粉饰):

- Dataelement `dsh-desktop`:~337 stars / 39 forks,3 天;同样不重写 Harness,但用 patch-package 改官方 onboarding/preset/branding 表面,自带 Harness home(macOS 已签名公证)。它是 Desktop 产品。
- `awesome-dsh-plugin`:~3289 stars / 657 forks,Discovery 目录。
- 我们:0 stars。市场注意力正在形成第一次路径依赖,双轨推进(见下),不能再"全打磨完再传播"。

Repo topology 完整 ≠ Ecosystem 完整。现在真实成熟度:产品初期、Labs 活跃、Registry 9 个验证插件、Marketplace UX 已稳定、用户接近 0。对外必须用这个口径,不得写"完整生态闭环"。

### 双轨节奏

```text
Engineering:               Distribution:
0.1.2 stable 三平台发布      定位叙事 + 架构文章
win/mac 打包收口           插件验证 / 对比 / demo
Session consistency        用户反馈回流
release reproducibility
```

两条轨道并行,不串行。

---

## 二、六个仓库不是六个产品

当前六仓最终定位如下:

```text
                         DeepSeek Official Runtime
                                  │
                                  ▼
                    ┌────────────────────────────┐
                    │       dsh-community        │
                    │  正式产品 / Canonical      │
                    └────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
             deepseek-harness-handbook   dsh-community-plugins
               Knowledge / Evidence       Registry / Compatibility
                    │                           │
                    └─────────────┬─────────────┘
                                  ▼
                         dsh-marketplace
                      Discovery / Install UX


────────────────────────────────────────────────────────────

 deepseek-harness-suite                dsh-community-edition
 Community Labs                        Merge & Archive
 前沿实验舱                            合流归档
```

对应仓库:

```text
https://github.com/kamanager2012/dsh-community

https://github.com/kamanager2012/deepseek-harness-suite

https://github.com/kamanager2012/deepseek-harness-handbook

https://github.com/kamanager2012/dsh-community-plugins

https://github.com/kamanager2012/dsh-marketplace

https://github.com/kamanager2012/dsh-community-edition
```

官方上游:

```text
https://github.com/deepseek-ai/deepseek-harness
```

---

## 三、唯一正式产品:dsh-community

这是整个生态最重要的规则。

### 用户永远只下载

```text
dsh-community
```

不是 Suite。

不是 Edition。

不是 Marketplace。

不是 Plugins。

### 对普通用户的唯一入口

```text
DSH Community
    │
    ├── Desktop
    └── Terminal / TUI
```

正式 Release 永远来自:

```text
kamanager2012/dsh-community/releases/latest
```

版本是三层，不要把 `package.json` 里的开发号写成“用户下载版本”：

```text
main / package.json     当前代码线 0.1.2
Stable                  v0.1.2 / releases/latest
Preview                 v0.1.2-preview（历史回归记录）
```

当前用户下载事实：

```text
Stable          v0.1.2  — Linux AppImage / macOS dmg / Windows NSIS
Preview         v0.1.2-preview（旧，仅 Linux）
不要再推 v0.1.1 AppImage（官方 dsh web 起不来）
```

### Stable 发布基线与 main 修复线

`v0.1.2` 是第一个三系统 Stable 的固定发布基线。当前 `main` 已进入发布后可靠性修复线：

```text
v0.1.2 tag
    ↓
exact Release assets
    ↓
main: Windows staging + first-launch reliability fixes
```

[`918f004`](https://github.com/kamanager2012/dsh-community/commit/918f004) 修复 Windows 完整依赖树暂存、压平和 ready stamp；[`e487cf0`](https://github.com/kamanager2012/dsh-community/commit/e487cf0) 让首次启动先显示加载页。它们不自动属于已经发布的 `v0.1.2` 资产。后续必须对 Release 页面真实下载的包做干净环境验证。

Windows / macOS 也必须只从 `dsh-community` 发布，不能改去 Suite 或 Edition。

**绝不能因为 Suite 有更先进功能,就让 Windows 用户或者高级用户去下载 Suite。**

否则 canonical 产品体系马上失效。

---

## 四、以后版本体系也只存在于 dsh-community

不要形成:

```text
Stable = community
Advanced = suite
Experimental = edition
```

这是错误的。

正确方式:

```text
DSH Community
│
├── Stable
├── Preview / Beta
└── Canary / Nightly
```

而 Suite 的关系是:

```text
Community Labs
      ↓
实验
      ↓
Reality Gate
      ↓
E2E
      ↓
安全验证
      ↓
进入 dsh-community Canary
      ↓
Preview
      ↓
Stable
```

所以:

> **Suite 是研发源,不是发行渠道。**

---

## 五、dsh-community 的职责

`dsh-community` 是唯一 Canonical Product。

它应该承担:

### 1. 正式发行

包括:

```text
Windows Desktop
macOS Desktop
Linux Desktop
Terminal / TUI
```

### 2. 官方 Runtime 生命周期管理

社区产品启动:

```text
@deepseek-ai/dsh
```

而不是重新实现 Agent Loop。

### 3. 官方 Session 兼容

核心原则:

```text
Official Session = source of truth
```

社区层不能维护第二套等价 Session 真源。

### 4. TUI / Desktop 体验

包括:

```text
Desktop Shell
TUI
Session Selector
Resume
Doctor
Settings
Diagnostics
Community Marketplace UI
```

### 5. Compatibility Layer

必须持续验证:

```text
官方 CLI
Profiles
Plugin surface
Session format
Runtime version
```

---

## 六、dsh-community 的硬边界

必须坚持:

```text
Official Runtime owns:

AgentLoop
LLM execution
Tool execution
Session persistence
Core runtime lifecycle
```

Community 只做:

```text
Distribution
UX
Compatibility
Lifecycle wrapper
Plugin ecosystem
Diagnostics
Safe integration
```

不能:

```text
重新实现 AgentLoop
重新实现完整 Session
fork 官方 event vocabulary
复制官方 packages/*
维护第二套 Harness Runtime
```

---

## 七、deepseek-harness-suite 的定位

Suite 已经正式改成:

# Community Labs

它不是第二套 Community Edition。

它也不是未来正式客户端下载页。

它的任务是测试:

```text
官方 SDK Transport
先进 TUI
安全能力
Checkpoint
Undo
Risk Engine
Audit
Process Governance
Runtime Bridge
Contract Probe
Experimental Desktop UX
```

一句话:

> **所有高风险、高变化、上游依赖不稳定的新能力先放 Suite。**

---

## 八、Suite 当前最重要的架构方向

目标结构:

```text
TUI / Desktop
      │
      ▼
DSH Bridge
Anti-Corruption Layer
      │
      ▼
Official @deepseek-ai/dsh-sdk-client
      │
      ▼
stdio JSON-RPC
      │
      ▼
Official DeepSeek Harness Runtime
      │
      ▼
Official SessionEvent
      │
      ▼
Bridge normalization
      │
      ▼
Community UI Events
```

核心原则:

> 官方 SDK 负责 transport。
> Community Bridge 负责 normalization 和 anti-corruption。

不能让 UI 直接绑定官方内部结构。

---

## 九、Suite 当前已经解决的重要问题

近期已经做了几轮 Reality Gate 收敛。

### 1. Official Session 污染问题

已经修正。

现在:

```text
Official ~/.dsh/sessions
        ↓
READ ONLY
```

Suite 自己的数据:

```text
~/.dsh/suite_sessions
```

这是正确方向。

---

## 十、Checkpoint / Workspace Jail 当前状态

已经实现:

```text
config.workspacePath binding
realpath canonicalization
nearest-existing-ancestor resolution
symlink escape detection
.. traversal prevention
NUL prevention
ASCII control chars prevention
SecurityBoundaryViolationError
undo 前再次 boundary check
```

特别解决:

```text
/workspace/link -> /outside

/workspace/link/new-file
```

即使 `new-file` 尚不存在,也不能通过祖先 symlink 越界。

### 但 Checkpoint 目前仍然是进程生命周期级别

当前:

```text
CheckpointRecord[]
```

仍主要存在内存。

所以:

```text
Persistent Undo      NO
Crash Recovery       NO
```

不能宣称已经实现 durable rollback。

未来可以再做:

```text
checkpoint persistence
crash recovery
restart restore
```

但暂时不是当前第一优先级。

---

## 十一、Risk Engine 当前状态

已经从原来的:

```text
read_*
get_*
view_*
```

这种工具名前缀信任模型升级。

当前 capability primitives:

```text
fs:read
fs:write
fs:delete

process:exec
process:kill

net:read
net:write

credential:read

git:write

system:mutate
```

支持:

```text
ToolDescriptor
  capabilities
  scope
  sideEffect
```

并已经实现:

```text
Unknown Tool
    ↓
FAIL CLOSED

process:exec
    ↓
HIGH
    ↓
requiresApproval = true
```

---

## 十二、Risk Engine 仍有一个重要未闭合问题

Shell whitelist 目前还有类似:

```text
startsWith("git status")
startsWith("echo ")
startsWith("cat ")
```

这种判断。

存在:

```bash
git status && dangerous_command

echo xxx > file
```

这类绕过风险。

所以必须继续升级:

```text
raw string prefix
      ↓
禁止
```

目标方案:

```text
Shell parsing
   ↓
single command validation
   ↓
reject:

|
&&
||
;
>
>>
$()
backticks
shell substitution
```

然后根据:

```text
executable
argv
redirection
pipeline
side effects
```

判断风险。

---

## 十三、Official SDK 当前状态

Suite 已经正式依赖:

```text
@deepseek-ai/dsh-sdk-client
```

这是正确方向。

官方 SDK 本身提供:

```text
DeepSeekHarness
HarnessClient

run()
subscribe()
session()
notifications
RunResult
SessionEvent[]
```

官方协议:

```text
stdio JSON-RPC
```

---

## 十四、SDK 目前仍存在一个核心未闭合点

Suite 当前尝试:

```text
dsh --profile jsonrpc-agent
```

作为 SDK runtime。

但官方 CLI 当前明确 shipped profile 是:

```text
web
headless
```

而 `jsonrpc-agent` 更接近 SDK runtime composition/example,并不是普通 shipped profile。

所以现在:

```text
SDK path
可能启动失败
      ↓
fallback headless
```

因此:

```text
SDK Architecture      YES
SDK Dependency        YES
SDK True E2E          NOT YET PROVEN
```

不能把:

```text
LABS / SDK
```

升级成:

```text
REAL
```

---

## 十五、下一步 SDK 的真正验收方式

必须新增真实 E2E:

```text
launch SDK runtime
     ↓
initialize
     ↓
prompt
     ↓
session.event
     ↓
assistant event
     ↓
tool event
     ↓
turn end
     ↓
final response
```

同时必须硬断言:

```text
executionMode === sdk_jsonrpc
```

测试期间禁止 fallback。

否则:

```text
SDK 启动失败
→ 自动 fallback
→ 测试仍然通过
```

是假绿。

---

## 十六、Official SessionEvent Adapter 当前状态

事件名称已经开始对齐:

```text
assistant/chunk
assistant/message
tool/call
tool/result
approval/asked
turn/start
turn/end
```

这是进步。

但是当前还有一个结构层问题。

官方 SessionEvent 是:

```text
event
├── type
├── seq
├── time
└── data
```

例如:

```text
assistant/chunk
    ↓
event.data.chunk
```

而当前 Suite 部分 mapping 仍然在直接猜:

```text
event.content
event.delta
event.args
event.id
```

所以应该改成:

```text
HarnessNotification
      ↓
notification.params.event
      ↓
SessionEvent
      ↓
switch(event.type)
      ↓
typed decoder(event.data)
      ↓
DshEvent
```

不要:

```text
as any
+
guess fields
```

---

## 十七、Fallback 当前状态

现在已经解决:

```text
SDK fallback 不再静默
```

会明确通知:

```text
SDK failed
→ switching to headless
```

Headless 非零 exit code 也已经开始 reject。

### 但还有 duplicate execution 风险

例如:

```text
SDK 收到 prompt
↓
Agent 已写文件
↓
transport 崩溃
↓
catch
↓
重新 headless 执行同一个 prompt
```

可能造成:

```text
double write
double API call
double migration
double external side effect
```

正确设计:

```text
phase = NOT_STARTED
phase = INITIALIZED
phase = PROMPT_ENQUEUED
phase = ACTIVE
```

只有:

```text
phase < PROMPT_ENQUEUED
```

允许 fallback。

一旦 prompt 已被官方 Runtime 接受:

```text
禁止自动 fallback
FAIL LOUD
```

---

## 十八、Interactive Approval 当前必须保持这个标签

```text
[BLOCKED_BY_UPSTREAM]
```

原因:

客户端 Risk Engine 可以判断:

```text
requiresApproval
```

但官方 TypeScript SDK 当前还没有开放完整:

```text
server → client request
client → server approval response
```

审批闭环。

所以不能假装已经实现 Runtime HITL。

---

## 十九、动态 Contract Probe

Suite 当前已经有真实探针:

```text
@deepseek-ai/dsh
        ↓
--dump-default-config
web --help
headless --help
```

用于观察:

```text
plugins
CLI flags
required upstream invariants
```

这是:

```text
Dynamic Runtime Invariant Probe
```

不是严格意义上的完整 Contract Diff。

### 当前状态

之前 GitHub CI 出现:

```text
15s cold-start timeout
```

后来已经把 timeout 扩大到:

```text
60s
```

这是合理修改。

但仍然应该区分:

```text
Probe works
```

和:

```text
Probe CI stable
```

不能混成一个结论。

---

## 二十、dsh-community-edition 的最终处理

这个仓库停止双线发展。

定位:

```text
Merge & Archive
```

把有价值部分合入:

```text
dsh-community
```

主要可能包括:

```text
Session selector UX
New / Resume / Sessions flows
Plugin catalog UX
CLI convenience
```

合并后:

```text
Archive / Deprecated
```

不能继续作为第二正式 Community 产品。

---

## 二十一、Handbook 定位

`deepseek-harness-handbook`

不是产品。

它是:

```text
Knowledge
Evidence
Facts
Operational Manual
Version Knowledge Base
```

主要承担:

```text
安装
Provider
Workspace
Session
Trajectory
CLI
SDK
Web UI
权限
配置
FAQ
故障排查
版本差异
Evidence Matrix
```

### Handbook KPI 不应该是文档数量

真正 KPI:

```text
事实准确率
命令可执行率
版本覆盖率
Retrieval 命中率
Upstream drift detection latency
First-run success rate
```

---

## 二十二、Plugins 定位

`dsh-community-plugins`

不是另一个 Plugin Manager。

它是:

```text
Community Compatibility Registry
```

负责记录:

```text
name
version
category
source
testedDsh
compatibility
verification
```

安装仍尽量走官方链:

```text
dsh plugin add
```

### 插件注册表长期目标

当前还是:

```text
human curated compatibility allowlist
```

未来需要升级到:

```text
verifiable compatibility supply chain
```

包括:

```text
npm existence
install smoke test
immutable commit
package digest
provenance
tested DSH versions
compatibility status
```

---

## 二十三、Marketplace 定位

`dsh-marketplace`

作用:

```text
Discovery
Browse
Search
Install UX
```

不是 Runtime。

不是 Package Manager replacement。

不是新的 Harness。

它最终应该消费:

```text
dsh-community-plugins
```

然后调用:

```text
official dsh plugin install chain
```

---

## 二十四、用户产品关系必须保持极简

普通用户眼里应该只有:

```text
DeepSeek Harness
      +
DSH Community
```

而不是:

```text
Community
Suite
Edition
Handbook
Marketplace
Plugins
```

六选一。

用户首页应该只有:

```text
Download DSH Community
```

然后:

```text
Windows
macOS
Linux
Terminal
```

---

## 二十五、开发者才需要知道完整生态

开发者视角:

```text
Official Runtime
      ↓
dsh-community
      ↓
Handbook
Plugins
Marketplace

Community Labs
      ↓
future features

Edition
      ↓
merge/archive
```

---

## 二十六、Community Labs → Product 的晋升机制

任何 Suite 功能不能因为:

```text
代码写好了
单测通过
README 写了
```

就进入正式产品。

必须经过:

```text
1. Reality Gate
2. Upstream Contract Gate
3. Security Boundary Gate
4. E2E
5. Cross-platform Smoke
6. Failure-path Test
7. Documentation
8. Canary
9. Preview
10. Stable
```

---

## 二十七、Reality Gate 状态标签

以后统一使用明确状态,不允许模糊表达。

建议:

```text
[REAL]

[PARTIAL]

[LABS]

[PROBE]

[READ-SAFE]

[FAIL-CLOSED]

[WORKSPACE-JAIL]

[UI-LEVEL]

[BLOCKED_BY_UPSTREAM]

[UNVERIFIED]

[MOCK]

[NOT_IMPLEMENTED]
```

严禁:

```text
production-ready
fully complete
fully secure
100% compatible
```

除非真的有对应证据。

---

## 二十八、当前 Suite 第一轮 Reality Gate 剩余核心问题

现在已经不是大规模重构阶段。

剩下主要集中在 4 个 seam:

### P0-A Shell Policy

去掉字符串 prefix 白名单绕过。

### P0-B True SDK Runtime E2E

找到并使用官方正确 JSON-RPC runtime entrypoint。

必须:

```text
executionMode = sdk_jsonrpc
```

真实通过。

### P0-C Typed SessionEvent Adapter

严格解析:

```text
event.type
event.data
```

不要猜字段。

### P0-D Fallback Replay Safety

只有 prompt 未 enqueue 时才能 fallback。

---

## 二十九、接下来不要继续扩功能

当前阶段禁止 Agent 自己增加:

```text
新 UI
新插件
新命令
新 Dashboard
新 AgentLoop
新 Session 层
新 Marketplace 功能
新大型架构
```

第一优先级:

> **把已有能力变成真实、稳定、可验证的能力。**

---

## 三十、下一阶段执行顺序（已更新）

建议严格按这个顺序:

```text
Phase 1
Suite Reality Gate 收口

↓

Phase 2
Edition → Community 合流

↓

Phase 3
dsh-community 3-OS Stable 基线已发布

↓

Phase 4
Distribution Reality Gate

exact Release artifact
clean Windows / macOS / Linux
first launch / Session / plugin / upgrade

↓

Phase 5
Handbook Drift CI

↓

Phase 4 workstreams
Plugin Supply Chain + Marketplace UX

↓

Phase 7
Labs 成熟功能分批晋升 Community
```

---

## 三十一、当前最重要的产品工作是 Distribution Reality Gate

`v0.1.2` 已经完成构建和三系统发布门槛。现在要验证的是：一个没有参与开发的人，下载 Release 页面上的真实安装包后能否完成用户闭环。

必须直接测试 exact release artifact，而不是 main 源码或 CI artifact:

```text
Windows clean VM → EXE 安装 → 首次启动 → 密钥 → new/resume → plugin → restart
macOS clean host → dmg 安装 → 首次启动 → 密钥 → new/resume → plugin → restart
Linux clean host → AppImage → 首次启动 → 密钥 → new/resume → plugin → restart
```

还要覆盖:

- 卸载 / 重装；
- 升级；
- 断网；
- 缺少 API key；
- Runtime 解压中断或半截失败；
- Web ↔ Desktop ↔ TUI 是否共享同一 `~/.dsh` Session。

在这些证据产生前，不能把“普通 CI 通过”或“main 已修复”写成 Stable 用户现实已验证。

---

## 三十二、核心产品哲学

整个项目必须始终坚持:

### 官方优先

```text
Official capability exists
→ use it
```

而不是重写。

### 社区增强

```text
Official gap exists
→ community extension
```

### 第三方借鉴

```text
Learn architecture / UX / method
≠ copy implementation
```

### Evidence first

```text
Code
Runtime
Tests
Contracts
E2E
```

优先于 README。

### Reality over hype

不为了显得厉害把:

```text
PARTIAL
```

写成:

```text
REAL
```

---

## 三十三、整个生态一句话定义

> **DeepSeek Harness Community 不是 DeepSeek Harness 的 fork，也不是功能最多的 Desktop 壳。它是以官方 Runtime 为 kernel 的社区发行版：同一套会话、三个入口、可验证插件、契约盯上游。六仓是角色，不是已经转起来的生态闭环。**

---

## 三十四、每个仓库一句话

```text
dsh-community
= Product / Canonical Distribution

deepseek-harness-suite
= Community Labs

deepseek-harness-handbook
= Knowledge / Evidence

dsh-community-plugins
= Compatibility Registry

dsh-marketplace
= Plugin Discovery / Distribution UX

dsh-community-edition
= Merge & Archive
```

---

## 三十五、给 Agent 的执行红线

任何接手 Agent 必须遵守:

1. **不得重新设计六仓战略。**
2. **不得把 Suite 变成正式用户发行版。**
3. **不得继续发展 community-edition。**
4. **不得重新实现官方 AgentLoop。**
5. **不得重新实现官方 Session persistence。**
6. **不得 vendor 官方 core packages。**
7. **不得用 README 声明替代真实代码。**
8. **不得把 fallback 成功当 SDK 成功。**
9. **不得把 unit test 绿当真实 Runtime E2E 绿。**
10. **未知 capability 默认 fail-closed。**
11. **安全边界必须测试 symlink / traversal / Windows path / process failure。**
12. **所有进入 dsh-community 的 Labs 能力必须通过 Reality Gate。**
13. **用户永远只从 dsh-community 下载正式软件。**

---

## 最终目标架构

```text
                         DeepSeek Official
                        Harness Runtime
                              │
                    Official SDK / CLI
                              │
                              ▼
                     DSH Community Bridge
                              │
               ┌──────────────┼──────────────┐
               ▼              ▼              ▼
              TUI           Desktop       Diagnostics
               │              │
               └──────┬───────┘
                      ▼
                DSH Community
                Canonical Product
                      │
             ┌────────┴────────┐
             ▼                 ▼
        Handbook             Plugins
                              │
                              ▼
                         Marketplace


                Community Labs
                      │
                Experiments
                      │
                Reality Gate
                      │
                E2E / Security
                      │
                      ▼
                DSH Community
```

## 最后只记住三句话

> **官方 Runtime 是发动机。**

> **dsh-community 是用户唯一正式产品。**

> **Suite 是实验室,只有经过 Reality Gate 的能力才能进入正式产品。**

这三条不变,整个项目以后无论再加多少功能、插件、客户端形态,都不会重新失控。
