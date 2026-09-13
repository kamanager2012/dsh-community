# ACS v1.4.x 优化方案（核实修订版）

> 基于 `~/.claude/hooks/` 部署代码 + `CLAUDE.md` 治理文档的逐条核实。原方案中几处结论与部署代码不符，已按核实结果修正。

---

## 现状勘误：三层漂移

### 第一层：版本漂移（源码快照缺失）

| 位置 | 声称版本 | 实际状态 |
|------|---------|---------|
| `current` symlink | → `versions/v1.2.0` | 过期，部署代码已是 v5.x |
| `versions/v1.2.0/` | v1.2.0 | 仅 8 个文件 |
| 部署 `acs_lite.py` | v1.5.0 | ~1700 行 |
| 部署 `hook_orchestrator.py` | v1.4.0 | 7.3KB |
| 部署 `orchestrator_config.json` | v1.4.0 | 与 v1.2.0 源码差异巨大 |

说明：`known-bugs.md` 中有 v1.4.1-v1.4.3 (formerly v5.x) 的逐条修复记录，并非纯黑盒。真正缺失的是 **可复现的 v5.x 源码快照**（`versions/v5.x/` 目录不存在），不是完全没有变更记录。

### 第二层：部署配置漂移（orchestrator_config.json vs v1.2.0 源码）

| 文件 | v1.2.0 源码 | 部署 (v5.0) |
|------|-----------|-------------|
| `proposal_guard.py` | 已移至 PostToolUse | **回到 PreToolUse.Write\|Edit** |
| `authority_invariant.py` | 已归档 | **重新激活在 PreToolUse.Write\|Edit** |
| `shadow_workspace.py` | 已归档 | **重新激活在 PreToolUse.Write\|Edit** |
| `abi_guard.py` | PostToolUse | **移至 PreToolUse.Write\|Edit** |
| `risk_engine.py` | PostToolUse Write/Edit/Bash | 改为 Write-only `risk_engine.py assess --stdin` |
| `runtime_loop.py` | 活跃 | 已移除 |

**核实确认**：`orchestrator_config.json` 现状核对无误。

### 第三层：治理文档漂移（CLAUDE.md vs 实际生效）

`/home/jamesoldman/CLAUDE.md` 明确写 `proposal_guard.py`、`authority_invariant.py`、`shadow_workspace.py`、`abi_guard.py` 等"未注册（仅存在于文件系统，不参与 hook 管线）"。

但 `orchestrator_config.json` 显示这四个全部实际挂在 **PreToolUse.Write|Edit** 生效中。

**危害**：参考 CLAUDE.md 的人（包括维护者自己）会以为这些是死代码，绕过评估和测试——这是比 versions/ 目录漂移更危险的误导。

### 补充：Cursor 绕过

`hook_orchestrator.py:11-17`:
```python
# Cursor Agent auto-imports Claude hooks — ACS/ORCH is Claude-only;
# never gate Cursor sessions.
_e = __import__("os").environ
if _e.get("CURSOR_PROJECT_DIR") or _e.get("CURSOR_VERSION") or _e.get("CURSOR_AGENT"):
    raise SystemExit(0)
```

- **定性**：这是 2026-07-16 一次性、有意的架构决策（13 个 `.bak_cursor_bypass_20260716T092135Z` 同时间戳批量备份文件为证），且有注释说明原因。不是 bug。
- **安全后果仍成立**：任何能伪造 `CURSOR_*` 环境变量的上下文（不限于 Cursor），都能让 ACS 完全失效。

---

## P0: 安全隐患（立即修复）

### P0-1: Hook 崩溃 = 静默允许

**文件**: `hook_orchestrator.py:127,134`

```python
# Line 127 — 超时
"TIMEOUT after {HOOK_TIMEOUT}s (treated as allow)"
# Line 134 — 异常
"ERROR: {e} (treated as allow)"
```

**危害**: 挂起的 hook 成为安全旁路。如果一个活跃的 PreToolUse hook 因依赖缺失而崩溃，所有操作都静默通过。

**修复**: PreToolUse 安全 hook 超时/错误改为 deny；PostToolUse 审计 hook 可以 allow。

```python
FAIL_OPEN_HOOKS = {"audit_hook.py", "token_budget.py"}   # 审计类挂掉可以放过
FAIL_CLOSED_HOOKS = {"acs_lite.py", "guard.py", "filesystem_guard.py",
                     "bash_guard.py", "proposal_guard.py", "abi_guard.py",
                     "authority_invariant.py", "shadow_workspace.py"}
```

### P0-2: CLAUDE_PROJECT_DIR 提权 【核实确认】

**文件**: `acs_paths.py:29-44`

```python
def _resolve_project_root() -> Path:
    env_root = os.environ.get(PROJECT_DIR_ENV)  # 完全受攻击者控制
    if env_root:
        p = Path(env_root).resolve()
        if p.is_dir():
            return p  # 攻击者设 CLAUDE_PROJECT_DIR=/ → 项目根=/
```

**`WRITABLE_PREFIXES` 派生链**（`acs_paths.py:92`）:
```python
WRITABLE_PREFIXES: List[Path] = [PROJECT]  # 直接派生自 PROJECT，无独立兜底
```

**危害**: `CLAUDE_PROJECT_DIR=/` → `PROJECT = /` → `is_writable()` 对任意路径返回 True。唯一防线是 `PROTECTED_ABSOLUTE` 硬编码黑名单，但无法枚举所有系统路径。

**修复**:
```python
FORBIDDEN_ROOTS = {"/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64",
                    "/proc", "/root", "/run", "/sbin", "/sys", "/tmp", "/usr", "/var"}
env_root = os.environ.get(PROJECT_DIR_ENV)
if env_root:
    p = Path(env_root).resolve()
    if str(p) in FORBIDDEN_ROOTS:
        sys.stderr.write(f"[ACS] REFUSED: CLAUDE_PROJECT_DIR={env_root} is forbidden\n")
        sys.exit(2)
```

### P0-3: tool_input 非 dict 导致崩溃 【核实确认，修正行号】

**文件**: `acs_lite.py:1231-1293`（部署文件，非 v1.2.0 的 704-722）

```python
tool = data.get("tool_name", "")
inp = data.get("tool_input", {})  # 可能是 string/None/list
# ...
fp = inp.get("file_path", "")      # AttributeError if inp is not dict
```

**核实**: 全文搜 `isinstance.*dict`，确认无任何类型防护。

**危害**: 畸形 hook 输入 → `AttributeError` → hook 崩溃 → 取决于 P0-1 修复状态，行为不可预测。

**修复**:
```python
inp = data.get("tool_input", {})
if not isinstance(inp, dict):
    sys.stderr.write("[ACS] Invalid tool_input type\n")
    sys.exit(2)
```

---

## P1: 正确性问题

### P1-1: _safe_resolve 实际跟随了 symlink 【核实确认】

**文件**: `acs_paths.py:184-189`

```python
def _safe_resolve(p: Path) -> Path:
    """v1.1.0: 不跟随 symlink（避免 symlink 攻击），但保留绝对性。"""
    return p.resolve(strict=False)  # ← Python 官方文档明确：resolve() 无论 strict 与否都解析 symlink
```

**危害**: docstring 和实际行为矛盾。Agent 可创建 symlink 绕过 ZONE 检查。`strict=False` 只影响缺失路径是否报错，不影响 symlink 解析。

**修复**:
```python
def _safe_resolve(p: Path) -> Path:
    """不跟随 symlink，返回绝对路径（保留未解析的 symlink 组件）。"""
    return Path(os.path.abspath(p))  # abspath 不跟随 symlink
```

### P1-2: read_guard 子串匹配绕过 【核实确认】

**文件**: `read_guard.py:133-135`

```python
for prefix in ALLOWED_PREFIXES:
    if prefix in fp:  # 子串匹配！
        sys.exit(0)
```

**危害**: 路径 `/home/user/Downloads/my-project/projects/gaokao/malware` 匹配 `/home/user/my-project/projects/gaokao/`，因为前者包含后者的子串。

**修复**:
```python
from pathlib import Path
resolved = Path(fp).resolve()
for prefix in ALLOWED_PREFIXES:
    if resolved.is_relative_to(Path(prefix).resolve()):
        sys.exit(0)
```

### P1-3: _save 临时文件孤儿 【修正诊断】

**文件**: `acs_violations.py:40-55`

```python
try:
    fd, tmp_path = tempfile.mkstemp(...)
    try:
        with os.fdopen(fd, "w") as f:   # with 语句保证不管什么异常都关闭 fd
            json.dump(data, f, ...)
        os.replace(tmp_path, path)
    except (OSError, PermissionError):
        os.unlink(tmp_path)
        return False
except Exception:
    return False  # ← tmp_path 孤儿（fd 已被 with 正确处理）
```

**纠正**: `with os.fdopen(fd, "w")` 保证 fd 始终被关闭——**fd 不泄露**。真正泄露的是 `tmp_path`：外层 `except Exception` 不清理孤儿临时文件。

**修复**: 添加 finally 块确保 tmp_path 清理，同时保持 with 的 fd 关闭。
```python
tmp_path = None
try:
    fd, tmp_path = tempfile.mkstemp(...)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, ...)
    os.replace(tmp_path, path)
    return True
except Exception:
    return False
finally:
    if tmp_path:
        try: os.unlink(tmp_path)
        except: pass
```

### P1-4: 已知 bugs

从 `known-bugs.md`:
1. **`_self_protect_bash regex 过于激进`**: `cat ~/.claude/settings.json` 被拦截
2. **`rm -rf 空目录触发 DANGEROUS_BASH`**: `find ... -delete` 可绕过

---

## P0-4 已确认修复

原方案提出的 "CATEGORY_MAP 重复两份（143-170 和 183-220）" 经核实：当前部署文件中 `CATEGORY_MAP` 仅出现一次（~172 行），紧邻注释写明 "v5.0 唯一正规定义（消除 v1.2.0 的重复 bug）"。该 bug 在 v1.2.0→v5.0 期间已修复。**从方案移除。**

---

## P2: 性能和架构

### P2-1: 7 个串行 Python 进程（每次 Write/Edit）

```
acs_lite.py → guard.py → filesystem_guard.py → proposal_guard.py
→ authority_invariant.py → shadow_workspace.py → abi_guard.py
```

每个 fork 新 `python3` 进程（~40-50ms），总延迟 ~280-350ms。

**修复**: 合并为单进程，顺序执行所有 guard，第一个 deny 就停止。

### P2-2: 完整性链无限增长

`integrity_store()` 只追加不删除。`integrity_chain_verify()` 每次都加载整个文件到内存。O(n) 每次，O(n²) 跨会话。

**修复**: 超过 1000 条时压缩合并最旧条目。

### P2-3: 重复 load_violations() I/O

`check_bash()` 每次被拒命令调用 `load_violations()` 两次——一次为打印 WARNING，一次为 `add_violation()` 内部加载。

**修复**: 加载一次，复用。

### P2-4: MODE_FILE 每次重新读取

每次 `check_bash()` 都读 `MODE_FILE`，但 MODE 几乎不变。

**修复**: 缓存 (mode, mtime)，仅 mtime 变化时重读。

---

## P3: 运维缺失

| 缺失项 | 影响 |
|--------|------|
| 无监控/metrics | 不知道 hook 是否正常工作 |
| 无性能追踪 | 不知道 hook 延迟是否恶化 |
| 无违规趋势 | 不知道攻击是否在升级 |
| 无告警 | hook 崩溃无人知晓 |
| `versions/v1.5.0/` 不存在 | v5.x 源码无版本控制 |
| 13 个 `.bak_cursor_bypass_20260716T092135Z` 批量备份残留 | 同一次改动的余留，清理即可 |
| CLAUDE.md 治理文档与实际配置矛盾 | 误导维护者以为活跃 hook 是死代码 |
| 无 CI/CD | 无自动化测试 |
| 无 `deploy.sh` | 部署是手工过程 |

---

## 实施建议（修订版）

| 阶段 | 内容 | 工作量 |
|------|------|--------|
| **立刻** | P0-2 CLAUDE_PROJECT_DIR 提权 + P0-3 tool_input 校验 | 半天 |
| **Week 1** | P0-1 Hook 崩溃策略 + P1-1 symlink + P1-2 子串匹配 + P1-3 tmp_path 孤儿 | 2 天 |
| **Week 1** | CLAUDE.md 治理文档同步（让文档准确反映当前部署配置） | 半天 |
| **Week 2** | P2 性能（单进程合并 + 完整性链压缩 + I/O 缓存） | 2 天 |
| **Week 2** | P3 运维（versions/v1.5.0/ + deploy.sh + .bak 清理） | 1 天 |
