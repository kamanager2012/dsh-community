# DeepSeek Harness Community 生态项目统一说明

## Project Handoff / Current Source of Truth

**日期：2026-08-16**

## 当前生态阶段全景与状态增量

```text
Phase 2 — Edition → Community 合流     ✅ COMPLETED (3704e77)
Phase 3 — 3-OS Stable Release (v0.1.4) ✅ COMPLETED (Linux AppImage / Win NSIS / macOS dmg)
Phase 4 — Distribution Reality Gate    🔄 ACTIVE (exact v0.1.4 artifact / clean-machine smoke)
  ├─ Plugin Supply Chain                ✅ MAIN WORK COMPLETE (9/9 install + compose)
  └─ Marketplace UX                     ✅ MAIN WORK COMPLETE (digest + provenance)
Phase 1/5 — 知识库与全景治理          🔄 IN PROGRESS (Handbook / Ecosystem)
```

Canonical 产品 Latest / 内核 pin 以 [`dsh-community/docs/current-release.json`](https://github.com/kamanager2012/dsh-community/blob/main/docs/current-release.json) 为准。Labs 上次完整验证线仍是 `0.1.0-rc.6`；未在新 pin 上重跑前，不要把 Suite 写成已验证当前 Latest。历史独立编号不再当下载入口。

### Suite (Community Labs) 真实性门禁快照

本轮 Reality Gate 已继续收口：Shell compound/metacharacter 已进入 fail-closed 测试，
SessionEvent mapper 已按官方 `event.data` envelope 解码，fallback 已加入
`isPromptEnqueuedOrActive` 防重放；三端会话同源只读解析已实装。

```text
Code / build / unit / contract tests       GREEN (33/33 tests passed)
Reality Gate adapter / fixture / failures  GREEN
Upstream contract probe CI                 GREEN (Offline snapshot fallback + Live probe)
True SDK runtime E2E                       UNVERIFIED (Pending upstream JSON-RPC profile)
```

---

# 一、项目到底在做什么

官方 DeepSeek Harness 是内核。Labs 基于官方内核做实验验证，不另造执行核心。

核心原则是：

> **官方 Runtime 是内核。Community 基于官方内核做发行、入口和外围验证。Labs 只做实验，不另起一套执行核心。**

项目方法论：

> 原版官方能力能直接使用就直接使用；  
> 官方能力不足时做社区扩展；  
> 第三方项目可以参考架构、交互和方法，但不复制代码和产品；  
> 所有功能必须以真实代码和真实运行结果为准，不允许用 README 描述代替实际能力。

最终目标不是搞很多仓库，而是形成一个围绕官方 DeepSeek Harness 的社区生态。

---

# 二、六个仓库不是六个产品

当前六仓最终定位如下：

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

对应仓库：

* `https://github.com/kamanager2012/dsh-community`
* `https://github.com/kamanager2012/deepseek-harness-suite`
* `https://github.com/kamanager2012/deepseek-harness-handbook`
* `https://github.com/kamanager2012/dsh-community-plugins`
* `https://github.com/kamanager2012/dsh-marketplace`
* `https://github.com/kamanager2012/dsh-community-edition`

官方上游：

* `https://github.com/deepseek-ai/deepseek-harness`

---

# 三、唯一正式产品：dsh-community

这是整个生态最重要的规则。

## 用户永远只下载：

```text
dsh-community
```

不是 Suite。不是 Edition。不是 Marketplace。不是 Plugins。

---

## 真正的三个社区发行端（Three Community Endpoints）

```text
                    Official DeepSeek Harness Runtime
                                   │
                  (共享 ~/.dsh 官方会话唯一真源)
                                   │
    ┌──────────────────────────────┼──────────────────────────────┐
    │                              │                              │
    ▼                              ▼                              ▼
WSL / Linux 终端             Windows 桌面端                 macOS 桌面端
(dsh-community CLI/TUI)    (DSH Community Setup.exe)      (DSH Community .dmg)
  (开发者 / CLI / WSL2)       (下载 → 安装 → 配Key → 用)     (下载 → 安装 → 配Key → 用)
    │                              │                              │
    └──────────────────────────────┴──────────────────────────────┘
                                   │
                  统一正式发行版：dsh-community
```

* **官方 Web**：上游自带界面，与三个社区端共享同一份 `~/.dsh` Session，不是我们发行的第四个产品；
* **Linux AppImage**：可选/次要构建产物（WSL/Linux 终端是 Linux 开发者最核心的主力端）。

正式 Release 永远来自：

```text
kamanager2012/dsh-community/releases/latest
```

当前版本层级：

```text
Stable Release:   v0.1.4
Preview Release:  v0.1.3 (当前最新 Preview)
Codebase Trunk:   0.1.4
```

目前 Release 资产已覆盖：

```text
Linux AppImage (v0.1.4 已发布，可选/次要)
Windows NSIS (v0.1.4 已发布)
macOS dmg (v0.1.4 已发布)
```

发布基线与开发线必须分开：`v0.1.4` 只代表 tag 上的固定资产；`main` 的后续文档、诊断和验证修复要等新的 Release 才能成为用户下载事实。

最新 `artifact-smoke` 的 macOS exact job 已通过、Windows exact job 失败；因此三系统 Release 已发布，但 exact artifact 用户现实门禁仍为 `[UNVERIFIED]`。

Windows / macOS 统一由 `dsh-community` 官方发布。

**绝不能因为 Suite 有更先进功能，就让 Windows 用户或者高级用户去下载 Suite。**

否则 canonical 产品体系马上失效。

---

# 四、核心护城河与用户价值定位：发行版（Distribution）

我们不是另一个普通的桌面壳，而是 **DeepSeek Harness 的社区发行版（Canonical Distribution）**。
如同 Linux 发行版（Debian/Fedora）之于 Linux Kernel，官方 Runtime 是发动机，我们提供完整的跨端发行与生态治理。

### 四层真实护城河（User Values）：

1. **官方原生兼容（Native Compatibility）**
   > *“Official DSH, without locking you into another fork.”*
   > 坚持零源码魔改（Zero Vendoring/Patching），不同于竞品使用 patch-package 修改上游 UI，官方升级零迁移成本与锁定风险。

2. **三个社区端同源一体（One Harness. Three Community Endpoints）**
   > *“你在官方 Web 启动的会话，关掉后在 WSL/Linux Terminal 秒级继续，切到 Windows 或 macOS Desktop 还是同一份会话与工作区。”*
   > 深度打通 `Official Web ↔ WSL/Linux Terminal ↔ Windows/macOS Desktop`，均以 `~/.dsh` 作为官方会话真源；官方 Web 是上游兼容入口，不是 Community 发行端。

3. **可验证插件生态（Verified Ecosystem - Trust over Volume）**
   > 不盲目与 Awesome 列表比拼 300+ 数量，而是建立 **可验证供应链（Verification Layer）**：
   > 真实安装烟测、权限静态审查、依赖真实性校验与多版本兼容矩阵（Tested on rc.6），提供 100% 跑通的信任底座。

4. **上游韧性演进（Upstream Resilience）**
   > *“DeepSeek 明天发 rc.7，我们比你先知道哪里会断，并完成发行兼容修复。”*
   > 动态契约探针实时捕捉上游变动，为社区提供可预测的平滑升级体验。

---

# 五、以后版本体系也只存在于 dsh-community

不要形成：

```text
Stable = community
Advanced = suite
Experimental = edition
```

这是错误的。

正确方式：

```text
DSH Community
│
├── Stable
├── Preview / Beta
└── Canary / Nightly
```

而 Suite 的关系是：

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

所以：

> **Suite 是研发源，不是发行渠道。**

---

# 五、dsh-community 的职责

`dsh-community` 是唯一 Canonical Product。

它应该承担：

### 1. 正式发行

包括：

```text
Windows Desktop
macOS Desktop
Linux Desktop
Terminal / TUI
```

### 2. 官方 Runtime 生命周期管理

社区产品启动：

```text
@deepseek-ai/dsh
```

而不是重新实现 Agent Loop。

### 3. 官方 Session 兼容

核心原则：

```text
Official Session = source of truth
```

社区层不能维护第二套等价 Session 真源。

### 4. TUI / Desktop 体验

包括：

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

必须持续验证：

```text
官方 CLI
Profiles
Plugin surface
Session format
Runtime version
```

---

# 六、dsh-community 的硬边界

必须坚持：

```text
Official Runtime owns:

AgentLoop
LLM execution
Tool execution
Session persistence
Core runtime lifecycle
```

Community 只做：

```text
Distribution
UX
Compatibility
Lifecycle wrapper
Plugin ecosystem
Diagnostics
Safe integration
```

不能：

```text
重新实现 AgentLoop
重新实现完整 Session
fork 官方 event vocabulary
复制官方 packages/*
维护第二套 Harness Runtime
```

---

# 七、deepseek-harness-suite 的定位

Suite 已经正式改成：

# Community Labs

它不是第二套 Community Edition。

它也不是未来正式客户端下载页。

它的任务是测试：

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

一句话：

> **所有高风险、高变化、上游依赖不稳定的新能力先放 Suite。**

---

# 八、Suite 当前最重要的架构方向

目标结构：

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

核心原则：

> 官方 SDK 负责 transport。  
> Community Bridge 负责 normalization 和 anti-corruption。

不能让 UI 直接绑定官方内部结构。

---

# 九、Suite 当前已经解决的重要问题

近期已经做了几轮 Reality Gate 收敛。

## 1. Official Session 污染问题

已经修正。

现在：

```text
Official ~/.dsh/sessions
        ↓
READ ONLY
```

Suite 自己的数据：

```text
~/.dsh/suite_sessions
```

这是正确方向。

---

# 十、Checkpoint / Workspace Jail 当前状态

已经实现：

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

特别解决：

```text
/workspace/link -> /outside

/workspace/link/new-file
```

即使 `new-file` 尚不存在，也不能通过祖先 symlink 越界。

---

## 但 Checkpoint 目前仍然是进程生命周期级别

当前：

```text
CheckpointRecord[]
```

仍主要存在内存。

所以：

```text
Persistent Undo      NO
Crash Recovery       NO
```

不能宣称已经实现 durable rollback。

未来可以再做：

```text
checkpoint persistence
crash recovery
restart restore
```

但暂时不是当前第一优先级。

---

# 十一、Risk Engine 当前状态

已经从原来的：

```text
read_*
get_*
view_*
```

这种工具名前缀信任模型升级。

当前 capability primitives：

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

支持：

```text
ToolDescriptor
  capabilities
  scope
  sideEffect
```

并已经实现：

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

# 十二、Risk Engine 与 Shell Policy 当前状态

历史上曾有 Shell whitelist 类似：

```text
startsWith("git status")
startsWith("echo ")
startsWith("cat ")
```

这种判断；以下记录的是已经收口的历史风险。

存在：

```bash
git status && dangerous_command

echo xxx > file
```

这类绕过风险已在 `a75a334` 通过 fail-closed 测试收口；当前仍不宣称完整跨平台 shell parser。

所以必须继续升级：

```text
raw string prefix
      ↓
禁止
```

目标方案：

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

然后根据：

```text
executable
argv
redirection
pipeline
side effects
```

判断风险。

---

# 十三、Official SDK 当前状态

Suite 已经正式依赖：

```text
@deepseek-ai/dsh-sdk-client
```

这是正确方向。

官方 SDK 本身提供：

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

官方协议：

```text
stdio JSON-RPC
```

---

# 十四、SDK 目前仍存在一个核心未闭合点

Suite 当前尝试：

```text
dsh --profile jsonrpc-agent
```

作为 SDK runtime。

但官方 CLI 当前明确 shipped profile 是：

```text
web
headless
```

而 `jsonrpc-agent` 更接近 SDK runtime composition/example，并不是普通 shipped profile。

所以现在：

```text
SDK path
可能启动失败
      ↓
fallback headless
```

因此：

```text
SDK Architecture      YES
SDK Dependency        YES
SDK True E2E          NOT YET PROVEN
```

不能把：

```text
LABS / SDK
```

升级成：

```text
REAL
```

---

# 十五、下一步 SDK 的真正验收方式

必须新增真实 E2E：

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

同时必须硬断言：

```text
executionMode === sdk_jsonrpc
```

测试期间禁止 fallback。

否则：

```text
SDK 启动失败
→ 自动 fallback
→ 测试仍然通过
```

是假绿。

---

# 十六、Official SessionEvent Adapter 当前状态

事件名称已经开始对齐：

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

当前 mapper 已按官方 envelope 读取 `event.data`；真实 Runtime E2E 仍需单独证明。

官方 SessionEvent 是：

```text
event
├── type
├── seq
├── time
└── data
```

例如：

```text
assistant/chunk
    ↓
event.data.chunk
```

当前映射已经收敛为：

```text
event.data.chunk
event.data.args
event.data.result
```

adapter/fixture 测试已覆盖这些路径，但手工构造 `SessionEvent` 或
`projectRawUpstreamEvent()` 仍不能证明：

```text
real official runtime → stdio JSON-RPC → real SessionEvent → final response
```

所以应该改成：

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

不要：

```text
as any
+
guess fields
```

---

# 十七、Fallback 当前状态

现在已经解决：

```text
SDK fallback 不再静默
```

会明确通知：

```text
SDK failed
→ switching to headless
```

Headless 非零 exit code 也已经开始 reject。

---

## Replay safety 当前状态

当前已经加入 `isPromptEnqueuedOrActive` 和生命周期阶段判断：

```text
phase = NOT_STARTED
phase = INITIALIZED
phase = PROMPT_ENQUEUED
phase = ACTIVE
```

只有：

```text
phase < PROMPT_ENQUEUED
```

允许 fallback。

一旦 prompt 已被官方 Runtime 接受：

```text
禁止自动 fallback
FAIL LOUD
```

这部分已有 failure-path 测试；真实 SDK transport E2E 仍是未验证项。

---

# 十八、Interactive Approval 当前必须保持这个标签

```text
[BLOCKED_BY_UPSTREAM]
```

原因：

客户端 Risk Engine 可以判断：

```text
requiresApproval
```

但官方 TypeScript SDK 当前还没有开放完整：

```text
server → client request
client → server approval response
```

审批闭环。

所以不能假装已经实现 Runtime HITL。

---

# 十九、动态 Contract Probe

Suite 当前已经有真实探针：

```text
@deepseek-ai/dsh
        ↓
--dump-default-config
web --help
headless --help
```

用于观察：

```text
plugins
CLI flags
required upstream invariants
```

这是：

```text
Dynamic Runtime Invariant Probe
```

不是严格意义上的完整 Contract Diff。

---

## 当前状态

之前 GitHub CI 出现：

```text
15s cold-start timeout
```

后来已经把 timeout 扩大到：

```text
60s
```

这是合理修改。

但仍然应该区分：

```text
Probe works
```

和：

```text
Probe CI stable
```

不能混成一个结论。

当前 Actions 应报告为：普通构建/测试绿，upstream contract probe job 红；不能因为本地
probe 或 adapter tests 通过，就把整体 Suite workflow 写成全绿。

---

# 二十、dsh-community-edition 的最终处理

这个仓库停止双线发展。

定位：

```text
Merge & Archive
```

把有价值部分合入：

```text
dsh-community
```

主要可能包括：

```text
Session selector UX
New / Resume / Sessions flows
Plugin catalog UX
CLI convenience
```

合并后：

```text
Archive / Deprecated
```

不能继续作为第二正式 Community 产品。

---

# 二十一、Handbook 定位

`deepseek-harness-handbook`

不是产品。

它是：

```text
Knowledge
Evidence
Facts
Operational Manual
Version Knowledge Base
```

主要承担：

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

---

## Handbook KPI 不应该是文档数量

真正 KPI：

```text
事实准确率
命令可执行率
版本覆盖率
Retrieval 命中率
Upstream drift detection latency
First-run success rate
```

---

# 二十二、Plugins 定位

`dsh-community-plugins`

不是另一个 Plugin Manager。

它是：

```text
Community Compatibility Registry
```

负责记录：

```text
name
version
category
source
testedDsh
compatibility
verification
```

安装仍尽量走官方链：

```text
dsh plugin add
```

---

## 插件注册表长期目标

当前还是：

```text
human curated compatibility allowlist
```

未来需要升级到：

```text
verifiable compatibility supply chain
```

包括：

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

# 二十三、Marketplace 定位

`dsh-marketplace`

作用：

```text
Discovery
Browse
Search
Install UX
```

不是 Runtime。

不是 Package Manager replacement。

不是新的 Harness。

它最终应该消费：

```text
dsh-community-plugins
```

然后调用：

```text
official dsh plugin install chain
```

---

# 二十四、用户产品关系必须保持极简

普通用户眼里应该只有：

```text
DeepSeek Harness
      +
DSH Community
```

而不是：

```text
Community
Suite
Edition
Handbook
Marketplace
Plugins
```

六选一。

用户首页应该只有：

```text
Download DSH Community
```

然后：

```text
Windows
macOS
Linux
Terminal
```

---

# 二十五、开发者才需要知道完整生态

开发者视角：

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

# 二十六、Community Labs → Product 的晋升机制

任何 Suite 功能不能因为：

```text
代码写好了
单测通过
README 写了
```

就进入正式产品。

必须经过：

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

# 二十七、Reality Gate 状态标签

以后统一使用明确状态，不允许模糊表达。

建议：

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

严禁：

```text
production-ready
fully complete
fully secure
100% compatible
```

除非真的有对应证据。

---

# 二十八、当前 Suite 第一轮 Reality Gate 剩余核心问题

现在已经不是大规模重构阶段。

剩下主要集中在 2 个 seam；Shell、typed event 和 pre-enqueue fallback 进入持续回归：

## 已完成回归：Shell Policy

`&&`、`;`、`|`、重定向、替换、反引号和换行等 compound/metacharacter 已要求审批或 fail-closed。

---

## P0-A True SDK Runtime E2E

找到并使用官方正确 JSON-RPC runtime entrypoint。

必须：

```text
executionMode = sdk_jsonrpc
```

真实通过。

---

## 已完成回归：Typed SessionEvent Adapter

严格解析并进入 typed decoder：

```text
event.type
event.data
```

不再以 `content`、`delta`、`args` 等猜测字段替代 envelope；fixture 绿仍不等于真实 Runtime E2E。

---

## 已完成回归：Fallback Replay Safety

只有 prompt 未 enqueue 时才能 fallback；`isPromptEnqueuedOrActive` 已阻止已接受 prompt 的自动重放。

## P0-B Upstream probe CI

修复 cold-start/contract probe workflow，使 upstream contract job 稳定变绿；把 probe、
contract diff 和 runtime E2E 分开报告。

---

# 二十九、接下来不要继续扩功能

当前阶段禁止 Agent 自己增加：

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

第一优先级：

> **把已有能力变成真实、稳定、可验证的能力。**

---

# 三十、下一阶段执行顺序（已更新）

建议严格按这个顺序：

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

# 三十一、当前最重要的产品工作是 Distribution Reality Gate

`v0.1.4` 已经完成构建和三系统发布门槛。现在要验证的是：一个没有参与开发的人，下载 Release 页面上的真实安装包后能否完成用户闭环。

必须直接测试 exact release artifact，而不是 main 源码或 CI artifact：

```text
Windows clean VM → `DSH.Community.Setup.0.1.4.exe` → 安装 → 首次启动 → 密钥 → new/resume → plugin → restart
macOS clean host → `dsh-community-0.1.4.dmg` → 安装 → 首次启动 → 密钥 → new/resume → plugin → restart
WSL/Linux clean host → `dsh-community` / `pnpm tui` → 密钥 → new/resume → plugin → restart
Linux AppImage → `dsh-community-0.1.4.AppImage` → 可选/次要 artifact smoke
```

还要覆盖：

- 卸载 / 重装；
- 升级；
- 断网；
- 缺少 API key；
- Runtime 解压中断或半截失败；
- 官方 Web ↔ WSL/Linux TUI ↔ Windows/macOS Desktop 是否共享同一 `~/.dsh` Session。

最新 `artifact-smoke` run [31935679026](https://github.com/kamanager2012/dsh-community/actions/runs/31935679026) 的 macOS exact job 通过、Windows exact job 失败；因此本门禁仍标为 `[UNVERIFIED]`。

在这些证据产生前，不能把“普通 CI 通过”或“main 已修复”写成 Stable 用户现实已验证。

---

# 三十二、核心产品哲学

整个项目必须始终坚持：

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

不为了显得厉害把：

```text
PARTIAL
```

写成：

```text
REAL
```

---

# 三十三、整个生态一句话定义

> **DeepSeek Harness Community 不是 DeepSeek Harness 的 fork，而是以官方 Runtime 为唯一执行核心、围绕兼容性、发行体验、插件生态、知识体系和安全实验构建的社区增强层。**

---

# 三十四、每个仓库一句话

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

# 三十五、给 Agent 的执行红线

任何接手 Agent 必须遵守：

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

# 最终目标架构

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
> **Suite 是实验室，只有经过 Reality Gate 的能力才能进入正式产品。**

这三条不变，整个项目以后无论再加多少功能、插件、客户端形态，都不会重新失控。
