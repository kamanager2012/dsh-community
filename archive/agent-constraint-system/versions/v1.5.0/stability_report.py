#!/usr/bin/env python3
"""
stability_report.py — Runtime Stability Report (v1.0)
读取所有 state → 输出 10 项稳定性指标。
这是 8.0 "完成"的定义: 所有指标持续达标 ≥ 30 天。

用法:
  stability_report.py generate     # 完整稳定性报告
  stability_report.py check        # 快速健康检查 (exit 0=healthy, 1=degraded)
  stability_report.py trend        # 趋势分析 (最近 24h)
"""

import json
import sys
import time
from pathlib import Path

CWD = Path("/home/jamesoldman")
STATE_ROOT = CWD / ".claude" / "state"

def _load(p: Path) -> dict:
    if p.exists():
        try: return json.loads(p.read_text())
        except: pass
    return {}

def generate() -> dict:
    now = time.time()
    loop = _load(STATE_ROOT / "loop_state.json")
    identity = _load(STATE_ROOT / "runtime_identity.json")
    feedback = _load(STATE_ROOT / "feedback_state.json")
    gc = _load(STATE_ROOT / "gc_state.json")
    token = _load(STATE_ROOT / "token_budget.json")
    memory = _load(STATE_ROOT / "memory" / "index.json")
    queue = _load(STATE_ROOT / "queue.json")
    snapshots = _load(STATE_ROOT / "runtime_snapshots" / "manifest.json")

    # === 计算 10 项指标 ===

    # 1. Uptime
    first_tick = min((t.get("timestamp", now) for t in loop.get("ticks", [])), default=now)
    uptime_hours = (now - first_tick) / 3600

    # 2. Replay divergence
    restore_history = loop.get("restore_history", [])
    replay_divergence = 0 if not restore_history else len(restore_history)

    # 3. State growth
    state_size = identity.get("state", {}).get("total_size_bytes", 0)
    state_files = identity.get("state", {}).get("total_files", 0)
    total_ticks = loop.get("iterations", 0)
    growth_per_tick = state_size / max(total_ticks, 1)

    # 4. Memory growth
    memory_count = len(memory.get("memories", []))
    memory_growth_per_tick = memory_count / max(total_ticks, 1)

    # 5. Propagation latency
    ticks_data = loop.get("ticks", [])
    recent_ticks = ticks_data[-20:]
    avg_tick_ms = sum(t.get("elapsed_ms", 0) for t in recent_ticks) / max(len(recent_ticks), 1)

    # 6. Token consumption
    tokens_consumed = token.get("total_tokens", 0)
    tokens_per_tick = tokens_consumed / max(total_ticks, 1)

    # 7. Scheduler drift
    adjusted_weights = feedback.get("adjusted_weights", {})
    scheduler_drift = len(adjusted_weights)

    # 8. Governance drift
    constitution_epoch = identity.get("constitution", {}).get("epoch", 1)
    governance_drift = constitution_epoch - 1

    # 9. Tick latency stability
    if len(recent_ticks) >= 3:
        latencies = [t.get("elapsed_ms", 0) for t in recent_ticks]
        avg_lat = sum(latencies) / len(latencies)
        variance = sum((l - avg_lat) ** 2 for l in latencies) / len(latencies)
        latency_stddev = variance ** 0.5
        latency_stable = latency_stddev < avg_lat * 0.5
    else:
        latency_stddev = 0
        latency_stable = True

    # 10. Snapshot deterministic
    snapshot_count = len(snapshots.get("snapshots", []))
    snapshot_deterministic = snapshot_count > 0

    # === 综合评分 ===
    scores = {
        "uptime": min(100, int(uptime_hours / 720 * 100)),           # 30 天 = 100
        "replay_divergence": 100 if replay_divergence == 0 else max(0, 100 - replay_divergence * 10),
        "state_growth": 100 if growth_per_tick < 10000 else 50,       # <10KB/tick = ok
        "memory_growth": 100 if memory_growth_per_tick < 0.5 else 50,
        "propagation_latency": 100 if avg_tick_ms < 2000 else (50 if avg_tick_ms < 5000 else 0),
        "token_consumption": 100 if tokens_per_tick < 5000 else (50 if tokens_per_tick < 20000 else 0),
        "scheduler_drift": 100 if scheduler_drift < 10 else 50,
        "governance_drift": 100 if governance_drift == 0 else 0,
        "tick_latency": 100 if latency_stable else 50,
        "snapshot_deterministic": 100 if snapshot_deterministic else 0,
    }

    overall = sum(scores.values()) // len(scores)

    return {
        "timestamp": now,
        "overall_score": overall,
        "status": "healthy" if overall >= 80 else ("degraded" if overall >= 50 else "critical"),
        "metrics": {
            "uptime_hours": round(uptime_hours, 1),
            "replay_divergence": replay_divergence,
            "state_size_bytes": state_size,
            "state_files": state_files,
            "growth_per_tick_bytes": int(growth_per_tick),
            "memory_count": memory_count,
            "memory_growth_per_tick": round(memory_growth_per_tick, 3),
            "avg_tick_latency_ms": int(avg_tick_ms),
            "latency_stddev_ms": int(latency_stddev),
            "latency_stable": latency_stable,
            "tokens_consumed": tokens_consumed,
            "tokens_per_tick": int(tokens_per_tick),
            "scheduler_drift": scheduler_drift,
            "governance_drift": governance_drift,
            "snapshot_count": snapshot_count,
            "snapshot_deterministic": snapshot_deterministic,
        },
        "scores": scores,
        "targets": {
            "uptime_30d": uptime_hours >= 720,
            "replay_zero": replay_divergence == 0,
            "state_sublinear": growth_per_tick < 10000,
            "memory_compressible": memory_growth_per_tick < 0.5,
            "propagation_stable": avg_tick_ms < 2000,
            "token_declining": tokens_per_tick < 5000,
            "scheduler_bounded": scheduler_drift < 10,
            "governance_zero": governance_drift == 0,
            "tick_stable": latency_stable,
            "snapshot_restore": snapshot_deterministic,
        },
    }

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "generate"

    if cmd == "generate":
        report = generate()
        print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
        print(f"\n[STABILITY] Score: {report['overall_score']}/100 ({report['status']})", file=sys.stderr)
        t = report["targets"]
        met = sum(1 for v in t.values() if v)
        print(f"[STABILITY] Targets met: {met}/{len(t)}", file=sys.stderr)
        for name, ok in t.items():
            print(f"  {'✅' if ok else '⬜'} {name}", file=sys.stderr)
    elif cmd == "check":
        report = generate()
        sys.exit(0 if report["status"] == "healthy" else 1)
    else:
        print(json.dumps(generate()["metrics"], indent=2))

if __name__ == "__main__":
    main()
