#!/usr/bin/env python3
"""
agent_memory.py — Agent Persistent Memory (v1.0)
解决 "每轮 request 都从零开始重新理解项目" 的问题。

原理:
  1. 维护一个 agent_state.json，记录 Agent 已知的模块、符号、文件 hash
  2. 每次请求前：检查哪些模块/文件自上次已知以来发生了变化
  3. 只加载变化的部分（增量），跳过已知不变的（跳过）
  4. 请求后：更新 state

用法:
  agent_memory.py snapshot                    # 快照当前状态
  agent_memory.py diff                        # 检测变化：哪些需要重新加载
  agent_memory.py mark-loaded <module>        # 标记模块已加载
  agent_memory.py status                      # 当前内存状态
  agent_memory.py reset                       # 重置（新会话）

集成:
  PostToolUse hook: 每次 Read 后更新 loaded 记录
  PreToolUse hook:  每次 Read 前检查是否已知不变 → 跳过
"""

import hashlib
import json
import os
import sys
import time
from pathlib import Path

CWD = Path("/home/jamesoldman")
STATE_ROOT = CWD / ".claude" / "state"
MEMORY_FILE = STATE_ROOT / "agent_memory.json"
SYMBOL_GRAPH = CWD / ".claude" / "governance" / "symbol-graph.json"
MODULES_DIR = CWD / ".claude" / "modules"


def _load() -> dict:
    if MEMORY_FILE.exists():
        try:
            return json.loads(MEMORY_FILE.read_text())
        except Exception:
            pass
    return {
        "version": "1.0",
        "created_at": time.time(),
        "last_updated": time.time(),
        "known_modules": {},      # {module_name: {"hash": "...", "loaded_at": ts}}
        "known_files": {},        # {path: {"hash": "...", "size": N}}
        "loaded_symbols": [],     # ["ExecutionContext", "TaskFSM", ...]
        "loaded_manifests": [],   # ["core-lite", "kernel", ...]
        "active_section": None,   # 当前聚焦的模块
        "stats": {
            "total_file_reads_avoided": 0,
            "total_tokens_saved_estimate": 0,
            "snapshots_taken": 0,
        },
    }


def _save(state: dict):
    os.makedirs(STATE_ROOT, exist_ok=True)
    state["last_updated"] = time.time()
    with open(MEMORY_FILE, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False, default=str)


def _hash_file(path: Path) -> str:
    if not path.exists():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


# ================================================================
# Snapshot: 快照当前项目状态
# ================================================================

def cmd_snapshot(paths: list = None) -> dict:
    """扫描项目文件，记录当前 hash。后续 diff 只检测变化。"""
    state = _load()

    if not paths:
        paths = [str(CWD / "my-project" / "projects" / "gaokao" / "frontend" / "src")]

    new_files = {}
    scanned = 0
    for root_path in paths:
        root = Path(root_path)
        if not root.exists():
            continue
        for f in root.rglob("*.ts"):
            if f.is_file() and "node_modules" not in str(f):
                rel = str(f)
                new_files[rel] = {"hash": _hash_file(f), "size": f.stat().st_size}
                scanned += 1

    # 对比旧状态，计算变化
    old_files = state.get("known_files", {})
    changed = [p for p in new_files if new_files[p]["hash"] != old_files.get(p, {}).get("hash", "")]
    added = [p for p in new_files if p not in old_files]
    removed = [p for p in old_files if p not in new_files]

    state["known_files"] = new_files
    state["stats"]["snapshots_taken"] = state["stats"].get("snapshots_taken", 0) + 1
    _save(state)

    print(f"[MEMORY] Snapshot: {scanned} files tracked", file=sys.stderr)
    if changed:
        print(f"[MEMORY] Changed: {len(changed)} files → these will need re-reading", file=sys.stderr)
    print(f"[MEMORY] Added: {len(added)}, Removed: {len(removed)}, Unchanged: {scanned - len(changed) - len(added)}",
          file=sys.stderr)

    return {
        "scanned": scanned,
        "changed": len(changed),
        "added": len(added),
        "removed": len(removed),
        "changed_files": changed[:20],
    }


# ================================================================
# Diff: 检测自上次以来哪些需要重新加载
# ================================================================

def cmd_diff() -> dict:
    """返回自上次 snapshot 以来的变化清单。Agent 只应关注这些。"""
    state = _load()
    known = state.get("known_files", {})

    if not known:
        return {"status": "no_snapshot", "message": "Run 'snapshot' first to establish baseline"}

    # 扫描当前文件系统
    current = {}
    for root_path in [str(CWD / "my-project" / "projects" / "gaokao" / "frontend" / "src")]:
        root = Path(root_path)
        if not root.exists():
            continue
        for f in root.rglob("*.ts"):
            if f.is_file() and "node_modules" not in str(f):
                current[str(f)] = _hash_file(f)

    changed = []
    for path, hash_val in current.items():
        old = known.get(path, {})
        if old.get("hash", "") != hash_val:
            changed.append({
                "path": path,
                "old_hash": old.get("hash", ""),
                "new_hash": hash_val,
            })

    stale = [p for p in known if p not in current]

    token_estimate = len(changed) * 5000  # rough: ~5K tokens per changed file

    return {
        "changed_files": len(changed),
        "stale_files": len(stale),
        "estimated_tokens_needed": token_estimate,
        "estimated_tokens_avoided": len(current) * 5000 - token_estimate,
        "changes": changed[:30],
    }


# ================================================================
# Mark: 标记已加载
# ================================================================

def cmd_mark_loaded(module_name: str = None, symbol_name: str = None, file_path: str = None):
    state = _load()

    if module_name:
        if module_name not in state["loaded_manifests"]:
            state["loaded_manifests"].append(module_name)
            # 记录 manifest hash
            manifest = MODULES_DIR / f"{module_name}.manifest.json"
            if manifest.exists():
                state["known_modules"][module_name] = {
                    "hash": _hash_file(manifest),
                    "loaded_at": time.time(),
                }
            print(f"[MEMORY] Module marked as known: {module_name}", file=sys.stderr)

    if symbol_name:
        if symbol_name not in state["loaded_symbols"]:
            state["loaded_symbols"].append(symbol_name)

    if file_path:
        fp = str(Path(file_path).resolve())
        state["known_files"][fp] = {"hash": _hash_file(Path(fp)), "loaded_at": time.time()}
        # 估算节省
        size = state["known_files"].get(fp, {}).get("size", 0)
        tokens_saved = max(1, size // 4)
        state["stats"]["total_file_reads_avoided"] = state["stats"].get("total_file_reads_avoided", 0) + 1
        state["stats"]["total_tokens_saved_estimate"] = state["stats"].get("total_tokens_saved_estimate", 0) + tokens_saved

    _save(state)


# ================================================================
# Status
# ================================================================

def cmd_status() -> dict:
    state = _load()
    return {
        "known_modules": len(state.get("known_modules", {})),
        "known_files": len(state.get("known_files", {})),
        "loaded_symbols": len(state.get("loaded_symbols", [])),
        "loaded_manifests": state.get("loaded_manifests", []),
        "active_section": state.get("active_section"),
        "working_set": state.get("working_set", {}),
        "stats": state.get("stats", {}),
    }


# ================================================================
# Working Set Runtime（跨请求持久工作集）
# ================================================================

def cmd_working_set(action: str = "show", **kwargs) -> dict:
    """
    Agent 的工作集——跨 turn 持久化。

    show:  返回当前工作集（这是 Agent 在开始推理前应该先看的）
    focus: 设置当前聚焦的模块/符号（切换上下文）
    add:   添加符号/模块到工作集
    clear: 清空工作集

    工作集是 Agent 的 "L1 cache"——包含当前 task 需要的所有符号和模块引用。
    Agent 不应该从 Cold 开始加载，应该先检查 working set。
    """
    state = _load()
    ws = state.setdefault("working_set", {
        "focused_module": None,
        "focused_task": None,
        "active_symbols": [],
        "active_modules": [],
        "pending_lookups": [],
        "last_access": time.time(),
    })

    if action == "show":
        return {
            "working_set": ws,
            "summary": f"Focus: {ws.get('focused_module') or 'none'} | "
                       f"Symbols: {len(ws.get('active_symbols', []))} | "
                       f"Modules: {len(ws.get('active_modules', []))}",
        }

    if action == "focus":
        module = kwargs.get("module")
        task = kwargs.get("task")
        if module:
            ws["focused_module"] = module
            if module not in ws["active_modules"]:
                ws["active_modules"].append(module)
        if task:
            ws["focused_task"] = task
        ws["last_access"] = time.time()
        _save(state)
        return {"focused": {"module": ws["focused_module"], "task": ws["focused_task"]}}

    if action == "add":
        symbols = kwargs.get("symbols", [])
        modules = kwargs.get("modules", [])
        for s in symbols:
            if s not in ws["active_symbols"]:
                ws["active_symbols"].append(s)
        for m in modules:
            if m not in ws["active_modules"]:
                ws["active_modules"].append(m)
        ws["last_access"] = time.time()
        _save(state)
        return {"added": {"symbols": len(symbols), "modules": len(modules)}}

    if action == "clear":
        state["working_set"] = {
            "focused_module": None,
            "focused_task": None,
            "active_symbols": [],
            "active_modules": [],
            "pending_lookups": [],
            "last_access": time.time(),
        }
        _save(state)
        return {"cleared": True}

    return {"error": f"Unknown action: {action}"}


# ================================================================
# Context Compiler（从 task → 最小上下文集）
# ================================================================

def cmd_compile_context(task_description: str, module_hint: str = None) -> dict:
    """
    根据 task 描述编译最小上下文集。

    不是全项目加载。只提取与当前 task 相关的符号和模块。

    输入: "修改 TaskFSM 的 transition 逻辑"
    输出: {symbols: [TaskFSM, TaskStatus, FSMTransition], modules: [kernel], manifests: [...]}
    """
    # 从 symbol-graph 提取相关符号
    symbols = []
    modules = set()
    manifests_needed = set()

    if not SYMBOL_GRAPH.exists():
        return {"error": "symbol-graph.json not found"}

    graph = json.loads(SYMBOL_GRAPH.read_text())
    files = graph.get("files", {})

    # 关键词匹配（后续可用向量检索升级）
    keywords = set(task_description.lower().split())
    if module_hint:
        keywords.add(module_hint.lower())

    for path, fi in files.items():
        matched = False
        # module hint 匹配
        if module_hint and module_hint.lower() in path.lower():
            matched = True

        # 符号名匹配
        for sym_name in fi.get("exports", {}):
            if any(kw in sym_name.lower() for kw in keywords):
                symbols.append({
                    "name": sym_name,
                    "file": path,
                    "kind": fi["exports"][sym_name].get("kind", "?"),
                })
                matched = True

        # interface 名匹配
        for iface_name in fi.get("interfaces", {}):
            if any(kw in iface_name.lower() for kw in keywords):
                if iface_name not in [s["name"] for s in symbols]:
                    symbols.append({
                        "name": iface_name,
                        "file": path,
                        "kind": "interface",
                    })
                matched = True

        if matched:
            module = path.split("/")[0] if "/" in path else "root"
            modules.add(module)
            manifests_needed.add(module)

    # 估算 token
    manifest_tokens = sum(
        (MODULES_DIR / f"{m}.manifest.json").stat().st_size // 4
        for m in manifests_needed
        if (MODULES_DIR / f"{m}.manifest.json").exists()
    )

    return {
        "task": task_description,
        "symbols_found": len(symbols),
        "modules_affected": len(modules),
        "symbols": symbols[:20],
        "modules": sorted(modules),
        "manifests_needed": sorted(manifests_needed),
        "estimated_tokens": manifest_tokens + len(symbols) * 200,
        # 对比全量加载的节省
        "full_load_tokens": graph.get("totals", {}).get("lines", 0) // 4,
    }


# ================================================================
# PreToolUse Hook: 拦截不必要的 Read
# ================================================================

def should_skip_read(file_path: str) -> tuple:
    """
    PreToolUse hook: 检查是否应该跳过 Read。

    如果文件自上次 snapshot 以来 hash 未变 → 跳过。
    返回 (skip: bool, reason: str, estimated_saved_tokens: int)
    """
    state = _load()
    known = state.get("known_files", {})

    fp = str(Path(file_path).resolve())
    info = known.get(fp)
    if not info:
        return (False, "not in snapshot", 0)

    current_hash = _hash_file(Path(fp))
    if current_hash and current_hash == info.get("hash", ""):
        size = info.get("size", 0)
        tokens = max(1, size // 4)
        state["stats"]["total_file_reads_avoided"] = state["stats"].get("total_file_reads_avoided", 0) + 1
        state["stats"]["total_tokens_saved_estimate"] = state["stats"].get("total_tokens_saved_estimate", 0) + tokens
        _save(state)
        return (True, f"unchanged (hash={current_hash[:8]})", tokens)

    return (False, f"changed or not in snapshot", 0)


# ================================================================
# CLI
# ================================================================

def main():
    if len(sys.argv) < 2:
        print("Usage: agent_memory.py <snapshot|diff|mark-loaded|status|reset|check-read> [args]",
              file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "snapshot":
        result = cmd_snapshot()
        print(json.dumps(result, indent=2, ensure_ascii=False))

    elif cmd == "diff":
        result = cmd_diff()
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
        if result.get("changed_files", 0) == 0:
            print(f"\n[MEMORY] No changes detected. All files known and unchanged.", file=sys.stderr)

    elif cmd == "mark-loaded":
        module = symbol = filepath = None
        for i, arg in enumerate(sys.argv):
            if arg == "--module" and i + 1 < len(sys.argv):
                module = sys.argv[i + 1]
            if arg == "--symbol" and i + 1 < len(sys.argv):
                symbol = sys.argv[i + 1]
            if arg == "--file" and i + 1 < len(sys.argv):
                filepath = sys.argv[i + 1]
        cmd_mark_loaded(module, symbol, filepath)

    elif cmd == "status":
        print(json.dumps(cmd_status(), indent=2, ensure_ascii=False, default=str))

    elif cmd == "working-set":
        action = sys.argv[2] if len(sys.argv) > 2 else "show"
        kwargs = {}
        module = task = None
        symbols = modules = []
        for i, arg in enumerate(sys.argv):
            if arg == "--module" and i + 1 < len(sys.argv):
                module = sys.argv[i + 1]
            if arg == "--task" and i + 1 < len(sys.argv):
                task = sys.argv[i + 1]
            if arg == "--symbols" and i + 1 < len(sys.argv):
                symbols = sys.argv[i + 1].split(",")
            if arg == "--modules" and i + 1 < len(sys.argv):
                modules = sys.argv[i + 1].split(",")
        result = cmd_working_set(action, module=module, task=task, symbols=symbols, modules=modules)
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

    elif cmd == "compile-context":
        task_desc = sys.argv[2] if len(sys.argv) > 2 else ""
        module_hint = None
        for i, arg in enumerate(sys.argv):
            if arg == "--module" and i + 1 < len(sys.argv):
                module_hint = sys.argv[i + 1]
        if not task_desc:
            print("Missing task description", file=sys.stderr)
            sys.exit(1)
        result = cmd_compile_context(task_desc, module_hint)
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

    elif cmd == "check-read":
        fp = sys.argv[2] if len(sys.argv) > 2 else None
        if not fp:
            print("Missing file_path", file=sys.stderr)
            sys.exit(1)
        skip, reason, tokens = should_skip_read(fp)
        result = {"skip": skip, "reason": reason, "saved_tokens": tokens}
        print(json.dumps(result, indent=2, ensure_ascii=False))
        if skip:
            print(f"\n[MEMORY] SKIP: {fp} — {reason} (save ~{tokens:,} tokens)", file=sys.stderr)
            sys.exit(2)  # exit 2 = BLOCK this Read

    elif cmd == "reset":
        if MEMORY_FILE.exists():
            MEMORY_FILE.unlink()
        print("[MEMORY] Reset — clean slate for new session", file=sys.stderr)

    else:
        print(f"Unknown: {cmd}", file=sys.stderr)
        sys.exit(1)


# ═════════════════════════════════════════════════════════════════════════
# v1.1.0: Hook 适配 (PreToolUse Read stdin 协议)
# ═════════════════════════════════════════════════════════════════════════

def main_stdin() -> None:
    """从 stdin 读 Claude Code hook JSON, 复用 should_skip_read 决定 Read 是否可跳过。

    skip=True → exit 2 (BLOCK Read)
    skip=False → exit 0 (allow Read)
    """
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    if data.get("tool_name") != "Read":
        sys.exit(0)
    fp = data.get("tool_input", {}).get("file_path", "")
    if not fp:
        sys.exit(0)
    try:
        skip, reason, tokens = should_skip_read(fp)
    except Exception:
        sys.exit(0)
    if skip:
        print(f"[MEMORY] BLOCKED: {fp} — {reason} (save ~{tokens:,} tokens)", file=sys.stderr)
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    # v1.1.0: 自动检测 stdin 模式 (hook) vs argv 模式 (CLI)
    try:
        if not sys.stdin.isatty():
            main_stdin()
        else:
            main()
    except Exception:
        sys.exit(0)
