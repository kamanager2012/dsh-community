#!/usr/bin/env python3
"""
runtime_loop.py — Unified Runtime Event Loop (v1.0)
收敛点。不是新工具。是把已有的 18 个工具串成一个确定性的 OS 事件循环。

架构:
  while active:
    scheduler.tick()       → unified_scheduler.py decide
    memory.decay()         → memory_runtime.py decay
    graph.propagate()      → incremental_runtime.py changed
    queue.dequeue()        → merge_queue.py dequeue
    executor.dispatch()    → shadow_workspace.py merge
    feedback.learn()       → feedback_loop.py analyze

用法:
  runtime_loop.py start [--max-iterations 10]   # 启动事件循环
  runtime_loop.py tick                           # 单步执行
  runtime_loop.py status                         # 循环状态
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

CWD = Path("/home/jamesoldman")
HOOKS = CWD / ".claude" / "hooks"
STATE_ROOT = CWD / ".claude" / "state"
LOOP_STATE = STATE_ROOT / "loop_state.json"

# 工具路径
TOOLS = {
    "scheduler": HOOKS / "unified_scheduler.py",
    "memory_decay": HOOKS / "memory_runtime.py",
    "incremental": HOOKS / "incremental_runtime.py",
    "merge_queue": HOOKS / "merge_queue.py",
    "shadow_workspace": HOOKS / "shadow_workspace.py",
    "feedback": HOOKS / "feedback_loop.py",
}

# ================================================================
# Tick Budget: Fast Path vs Slow Path
# ================================================================

# Fast Path 必须在 500ms 内完成。超时 → 跳过，下次再试。
FAST_PATH_TIMEOUT_MS = 500
# Slow Path 必须在 5s 内完成。超时 → 后台化，不阻塞下一 tick。
SLOW_PATH_TIMEOUT_MS = 5000
# 单 Tick 总超时
TICK_TIMEOUT_MS = 10000

# Fast Path phases (同步，必须快速)
FAST_PATH = {"schedule", "dispatch", "checkpoint"}
# Slow Path phases (可以异步，可以跳过)
SLOW_PATH = {"maintain", "learn"}

# Backpressure: 如果 queue backlog > 阈值，跳过 slow path
BACKPRESSURE_QUEUE_THRESHOLD = 5
# 如果 stale systems > 阈值，跳过 slow path（优先清理）
BACKPRESSURE_STALE_THRESHOLD = 10


def _run(tool: str, args: list, timeout: int = 30) -> dict:
    """运行一个工具并返回解析后的输出"""
    tool_path = TOOLS.get(tool)
    if not tool_path or not tool_path.exists():
        return {"error": f"Tool not found: {tool}"}

    try:
        r = subprocess.run(
            ["python3", str(tool_path)] + args,
            capture_output=True, text=True, timeout=timeout,
        )
        data = {}
        stdout = r.stdout
        start = stdout.find("{")
        if start >= 0:
            try:
                data = json.loads(stdout[start:])
            except json.JSONDecodeError:
                pass
        return {"ok": r.returncode == 0, "data": data, "tool": tool, "exit": r.returncode}
    except subprocess.TimeoutExpired:
        return {"error": "Timeout", "tool": tool}
    except Exception as e:
        return {"error": str(e), "tool": tool}


def _load_loop_state() -> dict:
    if LOOP_STATE.exists():
        return json.loads(LOOP_STATE.read_text())
    return {
        "version": "1.0",
        "active": False,
        "iterations": 0,
        "ticks": [],
        "last_error": None,
    }


def _save_loop_state(state: dict):
    os.makedirs(STATE_ROOT, exist_ok=True)
    state["updated_at"] = time.time()
    with open(LOOP_STATE, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False, default=str)


# ================================================================
# Tick: 单步执行整个 Runtime Loop
# ================================================================

def _run_with_timeout(tool: str, args: list, timeout_ms: int) -> dict:
    """带超时的工具执行。超时 → 返回 timeout 标记，不抛异常。"""
    import signal

    result = {"ok": False, "data": {}, "tool": tool, "timeout": False, "skipped": False}

    def _handler(signum, frame):
        raise TimeoutError()

    try:
        # 使用 subprocess timeout
        r = subprocess.run(
            ["python3", str(TOOLS[tool])] + args,
            capture_output=True, text=True,
            timeout=timeout_ms / 1000,
        )
        result["ok"] = r.returncode == 0
        stdout = r.stdout
        start = stdout.find("{")
        if start >= 0:
            try:
                result["data"] = json.loads(stdout[start:])
            except json.JSONDecodeError:
                pass
    except subprocess.TimeoutExpired:
        result["timeout"] = True
        result["skipped"] = True
    except Exception as e:
        result["error"] = str(e)

    return result


def tick(reason: str = "manual") -> dict:
    """
    一步完整的 Runtime 事件循环。

    v2: Tick Budget + Fast/Slow Path + Backpressure。

    Fast Path (同步, < 500ms):
      SCHEDULE → DISPATCH → CHECKPOINT
    Slow Path (可以跳过或异步):
      MAINTAIN → LEARN

    Backpressure: queue backlog > 5 或 stale > 10 → 跳过 Slow Path。
    """
    state = _load_loop_state()
    tick_id = state["iterations"] + 1
    tick_start = time.time()
    phases = {}
    budget_exceeded = []
    backpressure_triggered = False

    print(f"\n{'='*60}", file=sys.stderr)
    print(f"[LOOP] Tick #{tick_id} — {reason}", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)

    # ================================================================
    # Backpressure Check
    # ================================================================
    sched = _run_with_timeout("scheduler", ["decide"], FAST_PATH_TIMEOUT_MS)
    phases["schedule"] = {
        "ok": sched.get("ok", False),
        "recommendation": sched.get("data", {}).get("recommendation", "")[:80],
        "timeout": sched.get("timeout", False),
    }

    queue_count = len(sched.get("data", {}).get("tasks", []))
    stale_count = sched.get("data", {}).get("decision", {}).get("stale_systems", 0)

    backpressure_triggered = (
        queue_count > BACKPRESSURE_QUEUE_THRESHOLD or
        stale_count > BACKPRESSURE_STALE_THRESHOLD
    )

    if backpressure_triggered:
        print(f"[LOOP] BACKPRESSURE: queue={queue_count} stale={stale_count}. "
              f"Skipping slow path.", file=sys.stderr)

    # ================================================================
    # FAST PATH: DISPATCH (必须在 500ms 内)
    # ================================================================
    fast_start = time.time()

    dq = _run_with_timeout("merge_queue", ["dequeue"], FAST_PATH_TIMEOUT_MS)
    dequeued = dq.get("data", {}).get("dequeued", False)
    phases["dispatch"] = {
        "dequeued": dequeued,
        "timeout": dq.get("timeout", False),
    }

    if dequeued and not dq.get("timeout"):
        pid = dq.get("data", {}).get("proposal_id", "")
        merge = _run("shadow_workspace", ["merge", pid, "--force"], timeout=120)
        phases["dispatch"]["merged"] = merge.get("ok", False)
        phases["dispatch"]["proposal_id"] = pid

        if merge.get("ok"):
            _run_with_timeout("merge_queue", ["complete", pid], FAST_PATH_TIMEOUT_MS)
            _run_with_timeout("feedback", ["update-trust", "claude",
                                           "--outcome", "merge_success"], FAST_PATH_TIMEOUT_MS)
        else:
            _run_with_timeout("merge_queue", ["fail", pid, "--reason", "merge failed"],
                            FAST_PATH_TIMEOUT_MS)

    fast_elapsed = (time.time() - fast_start) * 1000
    if fast_elapsed > FAST_PATH_TIMEOUT_MS:
        budget_exceeded.append(f"dispatch:{fast_elapsed:.0f}ms > {FAST_PATH_TIMEOUT_MS}ms")

    # ================================================================
    # SLOW PATH: MAINTAIN + LEARN（可以跳过，可以超时）
    # ================================================================
    if not backpressure_triggered:
        slow_start = time.time()

        # Memory decay
        decay = _run_with_timeout("memory_decay", ["decay"], SLOW_PATH_TIMEOUT_MS)
        phases["maintain"] = {
            "memory_decay": decay.get("data", {}).get("degraded", 0),
            "timeout": decay.get("timeout", False),
            "skipped": backpressure_triggered,
        }

        # Feedback learn
        learn_start = time.time()
        if (time.time() - tick_start) * 1000 < TICK_TIMEOUT_MS * 0.8:
            fb = _run_with_timeout("feedback", ["analyze"], SLOW_PATH_TIMEOUT_MS)
            phases["learn"] = {
                "ok": fb.get("ok", False),
                "timeout": fb.get("timeout", False),
            }
        else:
            phases["learn"] = {"skipped": "tick budget nearly exhausted"}

        slow_elapsed = (time.time() - slow_start) * 1000
        if slow_elapsed > SLOW_PATH_TIMEOUT_MS:
            budget_exceeded.append(f"slow_path:{slow_elapsed:.0f}ms > {SLOW_PATH_TIMEOUT_MS}ms")
    else:
        phases["maintain"] = {"skipped": "backpressure"}
        phases["learn"] = {"skipped": "backpressure"}

    # ================================================================
    # CHECKPOINT
    # ================================================================
    tick_elapsed = time.time() - tick_start

    tick_record = {
        "tick_id": tick_id,
        "timestamp": tick_start,
        "reason": reason,
        "elapsed_ms": int(tick_elapsed * 1000),
        "phases": phases,
        "backpressure": backpressure_triggered,
        "budget_exceeded": budget_exceeded,
        "budget_ok": len(budget_exceeded) == 0,
        "verdict": (
            "merged" if phases.get("dispatch", {}).get("merged")
            else "idle" if not dequeued
            else "degraded" if budget_exceeded
            else "error"
        ),
    }

    # 每 25 个 tick 自动 Semantic Diff
    auto_semantic = (tick_id % 25 == 0)
    if auto_semantic:
        semantic_tool = HOOKS / "semantic_diff.py"
        if semantic_tool.exists():
            r = subprocess.run(
                ["python3", str(semantic_tool), "diff"],
                capture_output=True, text=True, timeout=30,
            )
            if r.returncode != 0:
                tick_record["semantic_warning"] = True
                print(f"[LOOP] Semantic drift detected!", file=sys.stderr)

    # 每 50 个 tick 自动 GC
    auto_gc = (tick_id % 50 == 0)
    if auto_gc:
        gc_tool = HOOKS / "graph_gc.py"
        if gc_tool.exists():
            subprocess.run(
                ["python3", str(gc_tool), "full"],
                capture_output=True, timeout=30,
            )

    # 每 10 个 tick 自动 snapshot
    auto_snapshot = (tick_id % 10 == 0)
    if auto_snapshot:
        snapshot_tool = HOOKS / "runtime_snapshot.py"
        if snapshot_tool.exists():
            subprocess.run(
                ["python3", str(snapshot_tool), "save",
                 "--label", f"auto-tick-{tick_id}"],
                capture_output=True, timeout=15,
            )
            tick_record["auto_snapshot"] = True

    state["iterations"] = tick_id
    state["ticks"].append(tick_record)
    state["ticks"] = state["ticks"][-50:]
    _save_loop_state(state)

    status = "⚠️ BACKPRESSURE" if backpressure_triggered else \
             "⚠️ BUDGET" if budget_exceeded else \
             tick_record["verdict"].upper()

    print(f"\n[LOOP] Tick #{tick_id} complete in {tick_elapsed*1000:.0f}ms → {status}",
          file=sys.stderr)
    if budget_exceeded:
        for b in budget_exceeded:
            print(f"  Budget: {b}", file=sys.stderr)

    return tick_record


# ================================================================
# Loop: 连续运行
# ================================================================

def start(max_iterations: int = 10, interval_seconds: int = 5) -> dict:
    """启动事件循环。最多 max_iterations 次。"""
    state = _load_loop_state()
    state["active"] = True
    _save_loop_state(state)

    results = []
    for i in range(max_iterations):
        try:
            record = tick(reason=f"auto (iteration {i+1}/{max_iterations})")
            results.append(record)

            if record["verdict"] == "idle":
                print(f"[LOOP] Idle — no pending work. Waiting {interval_seconds}s...",
                      file=sys.stderr)
                time.sleep(interval_seconds)
        except KeyboardInterrupt:
            print(f"\n[LOOP] Interrupted after {i+1} iterations", file=sys.stderr)
            break
        except Exception as e:
            print(f"[LOOP] Error in iteration {i+1}: {e}", file=sys.stderr)
            state["last_error"] = str(e)
            _save_loop_state(state)
            break

    state["active"] = False
    _save_loop_state(state)

    return {
        "iterations": len(results),
        "results": results,
    }


# ================================================================
# CLI
# ================================================================

def main():
    if len(sys.argv) < 2:
        print("Usage: runtime_loop.py <start|tick|status> [--max-iterations N] [--interval S]",
              file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "start":
        max_iter = 10
        interval = 5
        for i, arg in enumerate(sys.argv):
            if arg == "--max-iterations" and i + 1 < len(sys.argv):
                max_iter = int(sys.argv[i + 1])
            if arg == "--interval" and i + 1 < len(sys.argv):
                interval = int(sys.argv[i + 1])

        print(f"[LOOP] Starting runtime loop (max {max_iter} iterations, {interval}s interval)",
              file=sys.stderr)
        result = start(max_iter, interval)
        print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

    elif cmd == "tick":
        reason = "manual"
        for i, arg in enumerate(sys.argv):
            if arg == "--reason" and i + 1 < len(sys.argv):
                reason = sys.argv[i + 1]
        record = tick(reason)
        print(json.dumps(record, indent=2, ensure_ascii=False, default=str))

    elif cmd == "status":
        state = _load_loop_state()
        print(json.dumps({
            "active": state.get("active"),
            "iterations": state.get("iterations"),
            "last_error": state.get("last_error"),
            "recent_ticks": [
                {"tick_id": t["tick_id"], "verdict": t.get("verdict"), "elapsed_ms": t.get("elapsed_ms")}
                for t in state.get("ticks", [])[-5:]
            ],
        }, indent=2, ensure_ascii=False, default=str))

    else:
        print(f"Unknown: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
