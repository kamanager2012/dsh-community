#!/usr/bin/env python3
"""
prompt_compiler.py — Prompt Compiler (v1.0)
Task → Symbol Closure → Dependency Expansion → Priority Pruning → Token Budget → Final Context

用法:
  prompt_compiler.py compile "<task description>" [--budget 8000] [--module hint]
  prompt_compiler.py estimate "<task description>"
  prompt_compiler.py dump <module>             # 输出模块的编译后上下文

原理:
  不是把整个 repo 塞进 prompt。
  是从 symbol graph 中提取 task 相关的闭包，按语义优先级排序，在 token budget 内拟合。

  输入: "修改 TaskFSM transition 逻辑"
  输出: {symbols: [TaskFSM, TaskStatus, FSMTransition], manifests: [kernel], budget_used: 3200}
"""

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

CWD = Path("/home/jamesoldman")
SYMBOL_GRAPH = CWD / ".claude" / "governance" / "symbol-graph.json"
MODULES_DIR = CWD / ".claude" / "modules"
STATE_ROOT = CWD / ".claude" / "state"
COMPILED_DIR = STATE_ROOT / "compiled_contexts"

# Token 估算
TOKEN_PER_CHAR = 0.25
MANIFEST_OVERHEAD = 200  # 每个 manifest 的元数据开销
SYMBOL_OVERHEAD = 80     # 每个符号的结构开销

# 语义优先级（0-100）
SEMANTIC_PRIORITY = {
    "authority": 95,    # verify*, authorize*, checkPermission*
    "kernel_type": 90,  # ExecutionContext, TaskFSM, PipelineDAG
    "abi_type": 85,     # interface, type exports
    "runtime": 80,      # runtime-fsm, dag-builder
    "governance": 75,   # governance types
    "utility": 40,      # 工具函数
    "test": 10,         # 测试/mock
    "comment": 5,       # 注释/常量
}


def _load_graph() -> dict:
    if not SYMBOL_GRAPH.exists():
        return {"files": {}, "totals": {}}
    return json.loads(SYMBOL_GRAPH.read_text())


def _load_manifest(module: str) -> dict:
    path = MODULES_DIR / f"{module}.manifest.json"
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return {}


def _score_symbol(name: str, file_path: str, kind: str) -> int:
    """计算符号的语义优先级"""
    # Authority 函数 — 严格前缀匹配
    if re.match(r'^(verify|authorize|checkPermission|validate|assert|guard|require|ensure)(?=[A-Z])', name):
        return SEMANTIC_PRIORITY["authority"]
    # Kernel 类型 — 严格全词匹配，不用子串
    kernel_terms = r'\b(TaskFSM|TaskStatus|ExecutionContext|TokenBudget|PipelineDAG|PipelineStage|PipelineNode|EvictionPolicy|EvictionScore|ContextTier|ContextBudget|GovernanceSnapshot|MemoryBlock|MemoryStore|SymbolRef|ModuleRef|ProposalIR|AgentIdentity|AgentCapability)\b'
    if re.search(kernel_terms, name):
        return SEMANTIC_PRIORITY["kernel_type"]
    # ABI 类型（仅 kernel/ 和 core-lite/ 顶级）
    if kind in ("interface", "type") and re.match(r'^[A-Z]', name):
        if "kernel/" in file_path:
            return SEMANTIC_PRIORITY["kernel_type"]
        if file_path.startswith("core-lite/") and "/" not in file_path[len("core-lite/"):]:
            return SEMANTIC_PRIORITY["abi_type"]
    # Runtime 路径
    if "kernel/" in file_path:
        return SEMANTIC_PRIORITY["runtime"]
    # Governance
    if "governance" in file_path.lower():
        return SEMANTIC_PRIORITY["governance"]
    # 测试
    if "test" in file_path.lower() or "mock" in file_path.lower():
        return SEMANTIC_PRIORITY["test"]
    return SEMANTIC_PRIORITY["utility"]


def _tokenize(text: str) -> set:
    """简易分词"""
    # 驼峰拆分
    words = set()
    for word in re.findall(r'[A-Z]?[a-z]+|[A-Z]+(?=[A-Z][a-z]|\d|\b)', text):
        words.add(word.lower())
    # 全词
    for word in re.findall(r'\w+', text):
        words.add(word.lower())
    return words


# ================================================================
# 核心: Task → Symbol Closure
# ================================================================

def find_symbols(task: str, module_hint: str = None) -> list:
    """
    从 task 描述中找到相关符号。
    返回按语义优先级降序排列的符号列表。
    """
    graph = _load_graph()
    files = graph.get("files", {})
    keywords = _tokenize(task)
    if module_hint:
        keywords.add(module_hint.lower())

    results = []
    seen = set()

    for file_path, fi in files.items():
        exports = fi.get("exports", {})
        interfaces = fi.get("interfaces", {})

        # module hint 优先
        hint_match = module_hint and module_hint.lower() in file_path.lower()

        for sym_name, sym_info in exports.items():
            if sym_name in seen:
                continue

            score = 0
            # 精确关键词匹配
            sym_tokens = _tokenize(sym_name)
            overlap = keywords & sym_tokens
            if overlap:
                score += len(overlap) * 2

            # module hint 匹配
            if hint_match:
                score += 3

            # interface 字段匹配
            for iface_name in interfaces:
                if any(kw in iface_name.lower() for kw in keywords):
                    score += 1

            if score > 0:
                priority = _score_symbol(sym_name, file_path, sym_info.get("kind", "?"))
                results.append({
                    "name": sym_name,
                    "file": file_path,
                    "kind": sym_info.get("kind", "?"),
                    "module": file_path.split("/")[0] if "/" in file_path else "root",
                    "semantic_priority": priority,
                    "relevance_score": score,
                    "composite": priority + score,  # 排序用
                })
                seen.add(sym_name)

    # 按 composite 降序
    results.sort(key=lambda x: -x["composite"])
    return results


# ================================================================
# 核心: 编译最小上下文
# ================================================================

def compile_context(
    task: str,
    budget: int = 8000,
    module_hint: str = None,
) -> dict:
    """
    编译最小上下文集。

    算法:
      1. 从 symbol graph 提取相关符号闭包
      2. 按语义优先级 + 相关度排序
      3. 加载所需模块的 manifest
      4. 在 token budget 内拟合（高优先级符号先入）
      5. 超预算的符号降级为 "lazy_hydrate"（需要时再展开）
    """
    symbols = find_symbols(task, module_hint)

    # 收集需要的模块
    modules_needed = set()
    for s in symbols:
        modules_needed.add(s["module"])

    # 加载 manifests
    manifests = {}
    manifest_tokens = 0
    for mod in modules_needed:
        m = _load_manifest(mod)
        if m:
            manifests[mod] = {
                "file": f".claude/modules/{mod}.manifest.json",
                "symbol_count": m.get("symbol_count", 0),
                "file_count": m.get("file_count", 0),
                "key_interfaces": {
                    k: v for k, v in m.get("key_interfaces", {}).items()
                    if any(s["name"] == k for s in symbols)
                },
            }
            manifest_tokens += int(
                json.dumps(manifests[mod], ensure_ascii=False).__len__() * TOKEN_PER_CHAR
            ) + MANIFEST_OVERHEAD

    # 在 budget 内拟合
    remaining = budget - manifest_tokens
    hot_symbols = []       # 直接包含
    warm_symbols = []      # 摘要
    lazy_symbols = []      # 按需展开

    for s in symbols:
        sym_tokens = int(
            json.dumps({"name": s["name"], "kind": s["kind"], "file": s["file"]},
                      ensure_ascii=False).__len__() * TOKEN_PER_CHAR
        ) + SYMBOL_OVERHEAD

        if s["semantic_priority"] >= 80:
            # 高优先级 → 直接包含
            if sym_tokens <= remaining:
                hot_symbols.append(s)
                remaining -= sym_tokens
            else:
                warm_symbols.append(s)
        elif s["semantic_priority"] >= 50:
            if sym_tokens <= remaining:
                warm_symbols.append(s)
                remaining -= sym_tokens
            else:
                lazy_symbols.append(s)
        else:
            lazy_symbols.append(s)

    # 编译输出
    compiled = {
        "task": task,
        "compiled_at": time.time(),
        "budget": budget,
        "budget_used": budget - remaining,
        "budget_remaining": remaining,
        "manifests": manifests,
        "hot_symbols": hot_symbols,
        "warm_symbols": warm_symbols,
        "lazy_hydrate": lazy_symbols,
        "summary": {
            "total_symbols_found": len(symbols),
            "hot": len(hot_symbols),
            "warm": len(warm_symbols),
            "lazy": len(lazy_symbols),
            "modules_loaded": len(manifests),
        },
        # Context Tier 分配
        "tier_assignment": {
            "L1_active": [s["name"] for s in hot_symbols],
            "L2_module": [s["name"] for s in warm_symbols],
            "L3_symbol_index": [s["name"] for s in lazy_symbols],
        },
    }

    # 持久化
    os.makedirs(COMPILED_DIR, exist_ok=True)
    ctx_file = COMPILED_DIR / f"{int(time.time())}.json"
    with open(ctx_file, "w") as f:
        json.dump(compiled, f, indent=2, ensure_ascii=False, default=str)

    return compiled


# ================================================================
# 估算
# ================================================================

def estimate(task: str, module_hint: str = None) -> dict:
    """快速估算 token 消耗，不实际编译"""
    symbols = find_symbols(task, module_hint)

    # 实际源码大小
    src_root = Path("/home/jamesoldman/my-project/projects/gaokao/frontend/src")
    total_bytes = 0
    for f in src_root.rglob("*.ts"):
        if f.is_file() and "node_modules" not in str(f):
            total_bytes += f.stat().st_size
    full_tokens = total_bytes // 4

    # 估算：每个相关符号 ≈ 200 token（符号名 + 结构）+ 每个模块 manifest 2000
    modules = set(s["module"] for s in symbols)
    compiled_tokens = len(symbols) * 200 + len(modules) * 2000

    return {
        "task": task,
        "symbols_found": len(symbols),
        "modules_needed": len(modules),
        "full_source_tokens": full_tokens,
        "compiled_estimate": compiled_tokens,
        "saving_pct": int((1 - compiled_tokens / max(full_tokens, 1)) * 100),
        "comparison": f"{full_tokens:,}t → ~{compiled_tokens:,}t",
    }


# ================================================================
# Dump: 输出模块的已编译上下文
# ================================================================

def cmd_dump(module: str) -> dict:
    """输出单个模块的编译后上下文（给 Agent 直接使用）"""
    manifest = _load_manifest(module)
    graph = _load_graph()

    symbols = []
    for file_path, fi in graph.get("files", {}).items():
        if file_path.startswith(module + "/") or file_path.startswith(module):
            for name, info in fi.get("exports", {}).items():
                symbols.append({
                    "name": name,
                    "kind": info.get("kind", "?"),
                    "file": file_path,
                    "priority": _score_symbol(name, file_path, info.get("kind", "?")),
                })

    # 只保留高优先级
    hot = [s for s in symbols if s["priority"] >= 80]
    warm = [s for s in symbols if 50 <= s["priority"] < 80]

    return {
        "module": module,
        "manifest": manifest,
        "hot_symbols": hot[:30],
        "warm_symbols": warm[:20],
        "total_symbols": len(symbols),
        "instruction": "USE THIS INSTEAD OF READING SOURCE FILES. For body, use grep --symbol.",
    }


# ================================================================
# CLI
# ================================================================

def main():
    if len(sys.argv) < 2:
        print("Usage: prompt_compiler.py <compile|estimate|dump> [args]", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "compile":
        task = sys.argv[2] if len(sys.argv) > 2 else ""
        budget = 8000
        module_hint = None
        for i, arg in enumerate(sys.argv):
            if arg == "--budget" and i + 1 < len(sys.argv):
                budget = int(sys.argv[i + 1])
            if arg == "--module" and i + 1 < len(sys.argv):
                module_hint = sys.argv[i + 1]
        if not task:
            print("Missing task description", file=sys.stderr)
            sys.exit(1)

        result = compile_context(task, budget, module_hint)
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

        s = result["summary"]
        print(f"\n[COMPILER] Task: {task[:60]}", file=sys.stderr)
        print(f"[COMPILER] Budget: {result['budget']:,}t → Used: {result['budget_used']:,}t "
              f"(Remaining: {result['budget_remaining']:,}t)", file=sys.stderr)
        print(f"[COMPILER] Tier: L1={s['hot']} hot | L2={s['warm']} warm | L3={s['lazy']} lazy",
              file=sys.stderr)
        print(f"[COMPILER] Modules: {s['modules_loaded']}", file=sys.stderr)

    elif cmd == "estimate":
        task = sys.argv[2] if len(sys.argv) > 2 else ""
        module_hint = None
        for i, arg in enumerate(sys.argv):
            if arg == "--module" and i + 1 < len(sys.argv):
                module_hint = sys.argv[i + 1]
        if not task:
            print("Missing task description", file=sys.stderr)
            sys.exit(1)
        result = estimate(task, module_hint)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        print(f"\n[COMPILER] Full source: {result['full_source_tokens']:,}t → "
              f"Compiled: ~{result['compiled_estimate']:,}t "
              f"({result['saving_pct']}% saving)", file=sys.stderr)

    elif cmd == "dump":
        module = sys.argv[2] if len(sys.argv) > 2 else "core-lite"
        result = cmd_dump(module)
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

    else:
        print(f"Unknown: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
