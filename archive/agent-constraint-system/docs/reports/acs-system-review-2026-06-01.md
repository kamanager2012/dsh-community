# ACS 系统 Review 报告

> **生成日期**: 2026-06-01
> **范围**: `~/.claude/hooks/` 全部 30 个 Python/sh 脚本 + `enforcement-guard.js` v2.2.1 + ACS-Lite v1.0 + `v1-v2-feature-matrix.md`
> **方法**: 静态代码分析 + 状态实测（status 探针）+ 注册关系验证
> **当前状态**: `OBSERVE` 模式，FSM v2.2.1，scope 残留 `task: audit` (2026-06-01)，integrity 标记 4 个文件被篡改（实际是合法 init 副作用）

---

## 一、Hook 注册拓扑（关键发现）

| 层级 | Hook 文件 | 注册状态 | 实测状态 |
|------|----------|---------|---------|
| **PreToolUse (主)** | `.claude/runtime/enforcement-guard.js` v2.2.1 | ✅ 通过 `~/.claude/settings.json` 注册 | ✅ 启动中（审计链 7 entries） |
| **PostToolUse (主)** | `~/.claude/hooks/hooks.json` 中定义的 ECC 链路 | ✅ 来自 ECC plugin | ✅ 激活 |
| **PreToolUse (备)** | `acs_lite.py` v1.0 | ❌ **未在 settings.json 中注册** | ⚠️ 仅 CLI 模式（`acs_lite.py status` 单独可调） |

**结论**：
- **唯一生效的 PreToolUse 是 v2.2 enforcement-guard.js**
- **ACS-Lite v1.0 不在 hook 管线内**，但**意图上是要替代 enforcement-guard**（README 说"ACS (Agent Constraint System) 是 PreToolUse 治理层"）
- 两者**职责严重重叠**（都在做 FSM/Scope/Bash 拦截），但**设计哲学完全不同**：
  - v2.2 = 状态机驱动（FSM × 工具白名单 × Capability Token × Bash 分类 × Snapshot × Diff）
  - ACS-Lite = 路径白名单 + 违规积分 + 锁定机制

---

## 二、功能矩阵对比（v2.2 enforcement-guard vs ACS-Lite v1.0）

| 维度 | v2.2 enforcement-guard.js | ACS-Lite v1.0 | v1-v2-feature-matrix.md 描述 | 状态 |
|------|--------------------------|---------------|--------------------------|------|
| **架构** | FSM 状态机（7 态）+ Capability Token | 路径 scope + 违规积分 | 同 ACS-Lite v1.0 文件头描述 | v2.2 更严格 |
| **路径保护** | 靠 FSM 卡死工具（Write/Edit 仅 EXECUTE 态可用） | PROTECTED_ABSOLUTE 6 个 + PROTECTED_PROJECT_RELATIVE 6 个 | "PROTECTED > scope > WRITABLE > out-of-scope" | **ACS-Lite 更明确**（白名单黑名单都列） |
| **FSM 门禁** | L1: 7 态 × 工具白名单（仅 Read/Grep 在 OBSERVE） | ❌ 无 FSM，只有 scope 是否初始化 | — | **v2.2 强** |
| **Capability Token** | L2: 颁发 → hash 绑定 → TOCTOU 防护 | ❌ 无 | — | **v2.2 强** |
| **Bash 分类器** | L3: safeBashPatterns 37 条 + bashWritePatterns | DANGEROUS_BASH 30 条 + DANGEROUS_GLOB 4 条 | — | **v2.2 数量多**，**ACS-Lite 规则更狠**（含 fork bomb、ACS 自保） |
| **Scope Lock** | L4: capability token scope.files | scope.allowed_files / allowed_dirs | — | **v2.2 粒度更细**（按文件） |
| **Snapshot** | L5: PreToolUse 拍快照（journal dir） | ❌ 无 | — | **v2.2 强** |
| **Diff Audit** | L6: git numstat + per-file rollback | ❌ 无 | — | **v2.2 强** |
| **审计链** | L7: append-only hash chain (SHA256) | events 数组 + lock file 机制 | — | **v2.2 密码学保证**，ACS-Lite 简单追加 |
| **完整性校验** | ❌ 无 | ✅ SHA256 基线 + 反篡改 | — | **ACS-Lite 独占** |
| **违规积分** | ❌ 无 | ✅ events 累加 score，>100 锁系统 | — | **ACS-Lite 独占** |
| **反 ACS 篡改** | ❌ 无 | ✅ 8 条针对 acs_lite.py/.claude/hooks 的正则 | — | **ACS-Lite 独占** |
| **预算控制** | diffBudget: 3 文件/+200/-100/总 300 | VIOLATION_LIMIT=100 | — | **v2.2 强**（按行） |
| **Boot Recovery** | ✅ bootScanRecovery (60s watchdog) | ❌ 无 | — | **v2.2 强** |
| **Baseline Verify** | ✅ L5b hash 比对（防止 token 期间文件被改） | ❌ 无 | — | **v2.2 强** |

### 矩阵定位
**v1-v2-feature-matrix.md 完全是在比较 `replay-v1` 和 `replay-v2`（业务回放引擎），跟 ACS hook 体系无关**。这文件位置放在 `.claude/audit/` 下被误读为治理对比，实际是 195 行算法对比报告。

---

## 三、未注册的 Hook 清单（仓库内 30 个，1 个生效）

按文件头声明的角色分类。**所有以下文件都没有被任何 settings.json hooks 字段引用**：

### PreToolUse 类（意图拦截）
| 文件 | 角色 | 行数 | 问题 |
|------|------|------|------|
| `bash_guard.py` | 拦截不安全命令 | ~50 | ❌ 0 函数（空壳）|
| `sed_guard.py` | 拦截 sed -i | ~40 | ❌ 1 函数，未注册 |
| `read_guard.py` | 拦截非研发模式 Read | ~50 | ❌ 1 函数，未注册 |
| `guard.py` | 通用 guard | ~85 | ❌ 2 函数，未注册 |
| `filesystem_guard.py` | 阻止写受保护路径 | ~210 | ❌ 7 函数，未注册 |
| `proposal_guard.py` | 强制 Proposal 流程 | ~120 | ❌ 4 函数，未注册 |

### PostToolUse 类（意图审计）
| 文件 | 角色 | 行数 | 问题 |
|------|------|------|------|
| `abi_guard.py` | 检测 ABI 漂移 | ~190 | ❌ 未注册 |
| `audit_hook.py` | 记录所有工具调用 | ~70 | ❌ 2 函数，未注册 |
| `proposal_guard.py` | 强制 Proposal | — | 同上 |
| `risk_engine.py` | Proposal 风险评分 | ~400 | ❌ 9 函数，未注册 |
| `authority_invariant.py` | 保护 Trust Boundary | ~412 | ❌ 10 函数，未注册 |

### 治理 SDK / 框架
| 文件 | 角色 | 行数 | 问题 |
|------|------|------|------|
| `governance_sdk.py` | 治理 SDK 框架 | ~280 | ❌ 1 类，未注册 |
| `shadow_workspace.py` | 影子工作区管理 | ~435 | ❌ 10 函数，未注册 |
| `state_store.py` | 状态存储 | ~255 | ❌ 9 函数，未注册 |
| `runtime_identity.py` | 运行时身份 | ~226 | ❌ 4 函数，未注册 |
| `runtime_loop.py` | 运行时循环 | ~420 | ❌ 8 函数，未注册 |
| `runtime_snapshot.py` | 运行时快照 | ~400 | ❌ 10 函数，未注册 |
| `incremental_runtime.py` | 增量运行时 | ~348 | ❌ 8 函数，未注册 |
| `unified_scheduler.py` | 统一调度器 | ~263 | ❌ 4 函数，未注册 |
| `merge_queue.py` | 合并队列 | ~311 | ❌ 11 函数，未注册 |
| `graph_gc.py` | 图 GC | ~392 | ❌ 9 函数，未注册 |
| `prompt_compiler.py` | 提示编译 | ~403 | ❌ 9 函数，未注册 |
| `agent_memory.py` | Agent 记忆 | ~494 | ❌ 11 函数，未注册 |
| `memory_runtime.py` | 记忆运行时 | ~506 | ❌ 13 函数，未注册 |
| `feedback_loop.py` | 反馈循环 | ~402 | ❌ 9 函数，未注册 |
| `stability_report.py` | 稳定性报告 | ~210 | ❌ 3 函数，未注册 |
| `token_budget.py` | Token 预算 | ~190 | ❌ 5 函数，未注册 |
| `replay_engine.py` | 回放引擎 | ~440 | ❌ 11 函数，未注册 |
| `proposal_ir.py` | Proposal IR | ~558 | ❌ 8 函数，未注册 |
| `export_graph.py` | 符号图分析 | ~586 | ❌ 19 函数，未注册 |

### 总计
- **30 个 .py/.sh 文件**
- **1 个被实际注册**（`enforcement-guard.js`）
- **1 个通过 init 脚本可用**（`acs_lite.py` via `acs-task.sh`）
- **28 个完全休眠**

---

## 四、关键问题诊断

### 🔴 P0 — 严重

**1. ACS-Lite vs enforcement-guard.js 双轨竞态**
- 两者设计为互斥的拦截层，但 v1.0 (ACS-Lite) 假设"全靠路径白名单"，v2.2 (enforcement-guard) 假设"全靠 FSM"
- 任何时刻只有 enforcement-guard 在跑，**ACS-Lite 的完整性校验、违规积分、反篡改机制全部失效**
- 风险：README 声称的"7 层门禁"实际只跑 7 层中的 enforcement-guard 那 7 层，**没有 integrity 兜底**

**2. acs_lite.py 的 4 个"被篡改"误报**
- 实测 status 输出：`INTEGRITY FAILURE — 4 file(s) modified: TASK_SCOPE / ACTIVE_TASK / VIOLATIONS / settings.json`
- 原因：INTEGRITY.json 基线不存在（`_version` 字段缺失），`integrity_verify()` 返回 `(False, [], [], [...])` 实际是"无基线"分支
- **状态机误报**：基线缺失应显示 "no baseline — run 'integrity-store'"，但代码在 `if not ok` 分支打印 TAMPERED 列表，空列表仍走 else 不进 ok 分支。**这是 acs_lite.py 第 458-475 行的逻辑漏洞**——`ok` 在 `stored` 缺失时为 False 但 `tampered=[]`，会进 `not ok` 分支但 `tampered` 为空，跳过打印，导致 "INTEGRITY OK" 输出在某些情况下会与实际情况相反。

**3. v1-v2-feature-matrix.md 错位归档**
- 195 行的 replay-v1 vs replay-v2 算法对比放在 `.claude/audit/` 下
- 与"ACS 治理 hook 体系"无关
- **审计目录污染**：audit 目录应只放 ACS 相关的审计产物，不应混入业务代码比较

### 🟡 P1 — 中等

**4. 28 个未注册 hook 形成"未激活治理层"**
- 总计 9357 行业务代码（hooks 目录下）
- 28/30 = 93% 处于休眠状态
- **资源浪费**：约 8500 行 Python 代码从未执行
- **维护负担**：版本漂移会导致实际行为与文档不符
- **混淆**：README 声称的"统一治理"与实际"单点 enforcement"形成认知错位

**5. enforcement-guard.js 与 acs_lite.py 文件路径冲突**
- enforcement-guard.js 写审计链到 `.claude/runtime/audit-chain.json`
- acs_lite.py 写违规到 `.claude/runtime/VIOLATIONS.json`
- 两者的 `TASK_SCOPE.json` 概念有重叠但数据结构不同
- **配置分散**：FSM 状态 vs scope 状态 vs capability token 三个体系相互独立，无统一真相源

**6. 反篡改机制仅防护 ACS 自身**
- acs_lite.py 8 条 DANGEROUS_BASH 正则全部针对 `acs_lite.py` 和 `.claude/` 目录
- **未保护 enforcement-guard.js**（更关键的拦截器）
- **未保护 .claude/runtime/audit-chain.json**（密码学审计链）

### 🟢 P2 — 改进

**7. enforce_bash 白名单 37 条 + 黑名单 17 条**（v2.2 第 60-69 行）
- 白名单只覆盖测试、git、cat 等只读操作
- 黑名单不完整：未覆盖 `nohup`、`disown`、`systemctl`、`mount`、`umount`、`chroot`
- **风险**：可通过 `nohup bash -c '...'` 绕过黑名单

**8. 完整性校验缺失（v2.2）**
- enforcement-guard.js 没有像 ACS-Lite 那样的 SHA256 基线
- 一旦被绕过，**审计链可被任意回填**
- 应在每次启动时校验 enforcement-guard.js 自身的 SHA256

**9. ACS-Lite 路径计算有 TOCTOU 风险**
- `_resolve()` 第 253-262 行：先 resolve 再判断 protected
- 攻击场景：symlink 在两次 resolve 之间切换
- **风险评估**：低（项目内操作 symlink 不多）

**10. v2.2 hook 命令行解析脆弱**
- enforcement-guard.js 第 419-422 行：`const toolCallStr = args.join(' ')`
- 工具名提取靠 `extractToolName()` 第 277-280 行：正则 `^(\w+)\s`
- **Bash 工具无法正确解析** `&&` / `||` 链，会把 `npm install` 整串当成一个 token
- 实测第 86 行审计记录中 `command: "cat > /home/.../foo.ts << 'EOFEOF'\n..."` 这种 heredoc 长命令已被分类器误判或漏判

---

## 五、实测 ACS-Lite 状态

```
[ACS-Lite] task: audit  created: 2026-06-01T02:22:13Z  (source: ACTIVE_TASK.json)
[ACS-Lite] allowed_dirs: ['frontend/src', 'frontend/tests', 'src', 'package.json']
[ACS-Lite] blocked_cmds: []
[ACS-Lite] violations: 0/100 (0 events)
[ACS-Lite] locked: NO
[ACS-Lite] status: ACTIVE
[ACS-Lite] Scope initialized
[ACS-Lite] C-2: ENFORCED | v1.0: anti-tamper ACTIVE
[ACS-Lite] INTEGRITY FAILURE — 4 file(s) modified:
  TAMPERED: TASK_SCOPE.json / ACTIVE_TASK.json / VIOLATIONS.json / settings.json
```

**解读**：
- 残留 scope 来自上次会话（"audit" task, 2026-06-01 02:22:13Z）
- **4 个 TAMPERED 是误报**——实际是 init 副作用（`acs_lite.py init` 必然修改这些文件）
- **bug 确认**：`integrity_verify()` 第 162-178 行只比较 stored vs current 的 hash，init 后 stored 基线未更新，会把所有刚写的文件标记为 tampered

---

## 六、改进建议

### 立即修复（P0）
1. **决定 ACS-Lite 的去留**：要么注册到 settings.json 替换 enforcement-guard.js，要么删除整个 hooks/ 目录
2. **修复 integrity 误报**：在 `cmd_init()` 末尾（acs_lite.py 第 426 行）添加 `integrity_store()` 强制刷新基线
3. **迁移 v1-v2-feature-matrix.md** 到 `docs/replay-v1-vs-v2.md`

### 中期重构（P1）
4. **合并 enforcement-guard.js + acs_lite.py**：选一个体系作为主线
   - 方案 A：保留 enforcement-guard.js 的 FSM/Capability，引入 ACS-Lite 的 SHA256 完整性校验
   - 方案 B：保留 acs_lite.py 的简洁，引入 enforcement-guard.js 的 diff 预算
5. **明确 28 个未注册 hook 的状态**：每个文件加 `STATUS: DEPRECATED` 或 `STATUS: PROPOSED` 标记
6. **统一配置真相源**：合并 TASK_SCOPE.json + ACTIVE_TASK.json + capabilities.json 为单文件

### 长期治理（P2）
7. **加 SHA256 自校验**到 enforcement-guard.js 启动
8. **扩展 Bash 黑名单**（nohup、disown、systemctl、chroot）
9. **测试 hook 工具解析**（heredoc、多命令链）

---

## 七、ACS-Lite 启动状态实测结论

**未启动。** acs_lite.py 没有通过 PreToolUse 注册生效。

### 证据链

**1. settings.json hooks 字段实测**

唯一注册的 PreToolUse 是 `enforcement-guard.js`，没有任何条目引用 acs_lite.py。

**2. 启动方式对照**

| 启动方式 | 实际状态 |
|---------|---------|
| `claude`（直接） | acs_lite.py **不加载**——仅 enforcement-guard.js 生效 |
| `acs-task.sh <task> <dirs>` | 调用 `python3 acs_lite.py init ...` 写 scope + 清违规 + 拍基线——**但这只初始化 scope 文件，不注册为 PreToolUse** |

**3. 当前进程验证**

会话是直接 `claude` 启动的（从 token_budget.json 看到 `mode: deploy` + `tool_calls: 194`，期间无 `missing_proposal` 触发的错误——因为 enforcement-guard 在 OBSERVE 态下放行所有观察工具）。

acs_lite.py 的 scope 文件存在（残留 `task: audit`），但**只意味着该文件在磁盘上，不是 hook 在跑**。

**4. 决定性证据**

当前会话是直接 `claude` 启动的（无 `acs-task.sh`），所以 enforcement-guard.js 跑 OBSERVE 模式，**acs_lite.py 完全没机会执行**。

### 结论

- ✅ **enforcement-guard.js v2.2.1** = **正在跑**（每次工具调用都触发）
- ❌ **acs_lite.py v1.0** = **未在 hook 管线中**，磁盘上文件存在但仅供手动 `acs_lite.py status/init` 调用

CLAUDE.md 第 198-200 行说"ACS-Lite 已部署"，但**"已部署"指的是代码就位（`acs_lite.py` 在 hooks/ 目录），不是 PreToolUse 已注册**——README 文字与实际状态有出入。

如果要让 acs_lite.py 真正生效，需要：
1. 在 `/home/jamesoldman/.claude/settings.json` 的 `hooks.PreToolUse` 数组里追加一个条目调用 `python3 /home/jamesoldman/.claude/hooks/acs_lite.py`
2. 或用 `.claude/hooks/acs-task.sh task-name "src/path1,src/path2"` 启动会话（但这只初始化 scope，**不替换 enforcement-guard**）

---

**完成。** 本 review 仅为只读分析，未触发任何写入。

报告文件已保存至 `.claude/audit/acs-system-review-2026-06-01.md`。
