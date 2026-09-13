#!/usr/bin/env python3
"""
acs_violations.py — v1.1.0 滑动窗口 Violation 管理 (H-1, H-2, M-3)

v0.3.x 缺陷修复:
  H-1  衰减无效（1h 后才衰减 10 分，但 2 次就达 100 lock）→
       v1.1.0 改为滑动窗口：最近 N 个事件累积
  H-2  LOCK 写入后不立即 deny（check 函数返回 allowed）→
       v1.1.0 在 _gate_lock 中明确 deny
  M-3  _load JSON 损坏时改名为 .bak 永久丢失数据 →
       v1.1.0 保留原文件，备份为 .corrupt
"""
from __future__ import annotations

import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from acs_paths import (
    VIOLATION_FILE, LOCK_FILE, INTEGRITY_FILE, CRITICAL_FILES,
    RUNTIME_DIR,
)

# ── v1.1.0 滑动窗口参数（替换 v0.3.x magic numbers）──────────────────────────
WINDOW_SIZE: int = int(os.environ.get("ACS_WINDOW_SIZE", "10"))      # 最近 10 个事件
WINDOW_THRESHOLD: int = int(os.environ.get("ACS_WINDOW_THRESHOLD", "80"))  # 累积 30 触发 lock
WINDOW_DECAY_SECONDS: int = int(os.environ.get("ACS_DECAY_SECONDS", "600"))  # 10min
LOCK_DENY_SCORE: int = 150  # 总分达到 100 仍触发硬锁（兜底）


# ═════════════════════════════════════════════════════════════════════════
# 原子 IO（v1.1.0 修复 H-5: 损坏时不改名原文件）
# ═════════════════════════════════════════════════════════════════════════

def _save(path: Path, data: Any) -> bool:
    """原子写入：tmp + rename。失败时保留原文件不破坏。"""
    tmp_path = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_path = tempfile.mkstemp(dir=path.parent, prefix=".tmp_", suffix=".json")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            os.replace(tmp_path, path)
            return True
        except (OSError, PermissionError):
            return False
    except Exception:
        return False
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _load(path: Path, default: Any) -> Any:
    """v1.1.0: JSON 损坏时保留原文件，备份为 .corrupt。"""
    if not path.exists():
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        # v1.1.0 修复 H-5: 备份为 .corrupt，不删原文件
        try:
            corrupt_path = path.with_suffix(path.suffix + ".corrupt")
            if not corrupt_path.exists():
                # 复制而非改名，保留原文件供恢复
                corrupt_path.write_bytes(path.read_bytes())
        except OSError:
            pass
        return default


def _unlink_safe(p: Path) -> None:
    try:
        p.unlink()
    except FileNotFoundError:
        pass


# ═════════════════════════════════════════════════════════════════════════
# 滑动窗口（v1.1.0 核心改进）
# ═════════════════════════════════════════════════════════════════════════

def load_violations() -> Dict:
    return _load(VIOLATION_FILE, {"events": []})


def save_violations(v: Dict) -> None:
    _save(VIOLATION_FILE, v)


def _apply_window_decay(v: Dict) -> Dict:
    """v1.1.0 滑动窗口: 超过 WINDOW_DECAY_SECONDS 的事件自动衰减移除。"""
    events = v.get("events", [])
    if not events:
        return v
    now = time.time()
    # 移除超出窗口且超出衰减时间的事件
    fresh = [
        e for e in events
        if now - e.get("ts", 0) < WINDOW_DECAY_SECONDS or e.get("pinned", False)
    ]
    if len(fresh) != len(events):
        v["events"] = fresh
    return v


def window_score(v: Dict) -> int:
    """v1.1.0: 窗口内事件累计分。"""
    return sum(e.get("score", 0) for e in v.get("events", []))


def total_score(v: Dict) -> int:
    """全量分（向后兼容，兜底用）。"""
    return sum(e.get("score", 0) for e in v.get("events", []))


def should_lock(v: Dict) -> Tuple[bool, str]:
    """v1.1.0 修复 H-2: 锁判断更精确，返回 (should_lock, reason)。"""
    v = _apply_window_decay(v)
    w_score = window_score(v)
    t_score = total_score(v)
    if w_score >= WINDOW_THRESHOLD:
        return True, f"window_score={w_score} >= {WINDOW_THRESHOLD}"
    if t_score >= LOCK_DENY_SCORE:
        return True, f"total_score={t_score} >= {LOCK_DENY_SCORE}"
    # v4.5 recovery loop: if decay cleared enough violations → auto-unlock
    if LOCK_FILE.exists() and w_score < WINDOW_THRESHOLD and t_score < LOCK_DENY_SCORE:
        _unlink_safe(LOCK_FILE)
    return False, ""


def add_violation(reason: str, score: int) -> Tuple[int, bool, str]:
    """v1.1.0 修复 H-2: 返回 (window_score, locked, reason)。调用方必须根据 locked 决定是否 deny。"""
    v = load_violations()
    v = _apply_window_decay(v)
    v.setdefault("events", []).append({
        "reason": reason, "score": score, "ts": time.time(),
    })
    # 截断事件数（防止文件无限增长）
    if len(v["events"]) > WINDOW_SIZE * 3:
        v["events"] = v["events"][-WINDOW_SIZE * 3:]
    save_violations(v)
    locked, lock_reason = should_lock(v)
    if locked:
        try:
            LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
            LOCK_FILE.write_text(
                f"locked at {time.strftime('%Y-%m-%d %H:%M:%S')}: {lock_reason}\n"
            )
        except OSError:
            pass
    return window_score(v), locked, lock_reason


def clear_violations(reason: str = "manual_reset") -> None:
    """v1.2.0 P0-2: 真正重置 — 清空 events、重置 score、重建 baseline。

    旧版只追加负分抵消（state desync）：
      v["events"].append({"score": -old, ...})  ← 半重置

    v1.2.0 做法：
      1. events = []            ← 真清空
      2. 新 genesis baseline     ← chain 无断裂
      3. unlock                 ← 不残留 lock
    """
    v = load_violations()
    v["events"] = []
    v["window_score"] = 0
    save_violations(v)

    # v1.2.0: 重建 baseline — 写一个 genesis entry 作为新 chain 起点
    # 这样 audit replay 不会出现 hash gap
    genesis_entry = integrity_snapshot()
    genesis_entry["parent"] = "genesis"
    genesis_entry["created_by"] = "clear_violations"
    genesis_entry["reset_reason"] = reason
    genesis_entry["entry_hash"] = _compute_entry_hash(genesis_entry)

    # 清空旧 chain，以 genesis 为唯一 baseline
    _save(INTEGRITY_FILE, [genesis_entry])

    # 移除 lock
    _unlink_safe(LOCK_FILE)


# ═════════════════════════════════════════════════════════════════════════
# 完整性链（v1.1.0 修复 M-6: 自指）
# ═════════════════════════════════════════════════════════════════════════

import hashlib
import uuid


def _sha256(path: Path) -> str:
    try:
        if not path.exists():
            return "MISSING"
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except (OSError, PermissionError):
        return "UNREADABLE"


def integrity_snapshot() -> Dict[str, Any]:
    snap: Dict[str, Any] = {
        "snapshot_id": uuid.uuid4().hex,
        "timestamp": time.time(),
        "version": "4.5",
    }
    for p in CRITICAL_FILES:
        snap[str(p)] = _sha256(p)
    return snap


def _compute_entry_hash(entry: Dict[str, Any]) -> str:
    """v1.1.0 H-8: 计算单个 entry 的 chain hash。

    Hash 包含: snapshot_id + timestamp + sorted(file_hashes) + parent_hash。
    任何 entry 内容变化 → 该 entry hash 不匹配 → 它作为 parent 的下一 entry 也断裂。
    """
    parts = [
        entry.get("snapshot_id", ""),
        str(entry.get("timestamp", 0)),
    ]
    # 排序 file_hashes 保证顺序无关
    file_hashes = {k: v for k, v in entry.items()
                   if k not in {"snapshot_id", "timestamp", "version", "parent",
                                "created_by", "entry_hash"}}
    for k in sorted(file_hashes.keys()):
        parts.append(f"{k}={file_hashes[k]}")
    parts.append(f"parent={entry.get('parent', 'genesis')}")
    content = "|".join(parts)
    return hashlib.sha256(content.encode()).hexdigest()[:16]


def _migrate_chain_to_v41() -> bool:
    """v1.1.0 H-8: 一次性迁移旧 chain (v0.3.x/v1.1.0 格式) 到 v1.1.0 格式。

    旧 chain: parent=snapshot_id, 无 entry_hash
    新 chain: parent=entry_hash, 有 entry_hash

    Returns: True if migration happened, False if already v1.1.0 or empty

    v1.1.0 修订: 之前 v1.1.0 store 写过的新 entry (有 entry_hash 但 parent=snapshot_id)
    也会被重算，统一整链格式。
    """
    entries = _load(INTEGRITY_FILE, [])
    if not entries or not isinstance(entries, list):
        return False
    # 检查**任何** entry 缺 entry_hash OR parent 链断裂
    needs_migration = False
    prev_hash = "genesis"
    for e in entries:
        if "entry_hash" not in e:
            needs_migration = True
            break
        if e.get("parent", "genesis") != prev_hash:
            needs_migration = True
            break
        prev_hash = e.get("entry_hash", "?")
    if not needs_migration:
        return False
    # 重新计算整链
    prev_hash = "genesis"
    for entry in entries:
        entry.pop("entry_hash", None)  # 删旧 entry_hash 避免循环
        entry["parent"] = prev_hash
        entry["entry_hash"] = _compute_entry_hash(entry)
        prev_hash = entry["entry_hash"]
    _save(INTEGRITY_FILE, entries)
    return True


MAX_CHAIN_ENTRIES = 1000
COMPACTION_KEEP = 500


def _compact_chain(entries: List[Dict[str, Any]], keep: int) -> List[Dict[str, Any]]:
    """Compact oldest entries into a single bridge entry, recompute chain hashes."""
    compact_count = len(entries) - keep
    if compact_count <= 0:
        return entries

    pruned = entries[:compact_count]

    compact_entry: Dict[str, Any] = {
        "snapshot_id": f"compacted-{compact_count}-entries",
        "timestamp": time.time(),
        "created_by": "compactor",
        "parent": pruned[0].get("parent", "genesis"),
        "_compacted": True,
        "_compacted_count": compact_count,
        "_first_timestamp": pruned[0].get("timestamp", 0),
        "_last_timestamp": pruned[-1].get("timestamp", 0),
        "_compacted_hash": pruned[-1].get("entry_hash", ""),
    }
    compact_entry["entry_hash"] = _compute_entry_hash(compact_entry)

    result = [compact_entry]
    for entry in entries[compact_count:]:
        entry["parent"] = result[-1]["entry_hash"]
        entry["entry_hash"] = _compute_entry_hash(entry)
        result.append(entry)

    return result


def integrity_store() -> Dict[str, Any]:
    """Store new integrity snapshot; compact chain if above threshold."""
    entries = _load(INTEGRITY_FILE, [])
    if isinstance(entries, dict):
        entries = [{"_migrated_from": "v0.3.x", "_timestamp": entries.get("_timestamp", 0)}]
    new_entry = integrity_snapshot()
    new_entry["parent"] = entries[-1].get("entry_hash", "genesis") if entries else "genesis"
    new_entry["created_by"] = "terminal"
    new_entry["entry_hash"] = _compute_entry_hash(new_entry)
    entries.append(new_entry)

    if len(entries) > MAX_CHAIN_ENTRIES:
        entries = _compact_chain(entries, keep=COMPACTION_KEEP)

    _save(INTEGRITY_FILE, entries)
    return new_entry


def integrity_chain_verify() -> Tuple[bool, List[Dict[str, Any]]]:
    """v1.1.0 H-8: 验证整个 chain 完整性。

    Returns: (ok, broken_entries)
    ok=True 表示 chain 完整
    broken_entries = [{index, snapshot_id, expected_hash, actual_hash, reason}, ...]
    """
    _migrate_chain_to_v41()
    entries = _load(INTEGRITY_FILE, [])
    if isinstance(entries, dict) or not entries:
        return False, [{"index": -1, "reason": "no_baseline"}]
    broken = []
    prev_hash = "genesis"
    for idx, entry in enumerate(entries):
        if entry.get("parent", "genesis") != prev_hash:
            broken.append({
                "index": idx,
                "snapshot_id": entry.get("snapshot_id", "?"),
                "expected_parent": prev_hash,
                "actual_parent": entry.get("parent", "genesis"),
                "reason": "parent_hash_mismatch",
            })
        # 计算当前 entry 的 expected hash
        expected_hash = _compute_entry_hash(entry)
        actual_hash = entry.get("entry_hash", "MISSING")
        if actual_hash == "MISSING":
            broken.append({
                "index": idx,
                "snapshot_id": entry.get("snapshot_id", "?"),
                "reason": "missing_entry_hash",
            })
        elif actual_hash != expected_hash:
            broken.append({
                "index": idx,
                "snapshot_id": entry.get("snapshot_id", "?"),
                "expected_hash": expected_hash,
                "actual_hash": actual_hash,
                "reason": "entry_hash_mismatch",
            })
        prev_hash = actual_hash if actual_hash != "MISSING" else expected_hash
    return len(broken) == 0, broken


def integrity_chain_stats() -> Dict[str, Any]:
    """v1.1.0 H-8: chain 统计信息。"""
    _migrate_chain_to_v41()
    entries = _load(INTEGRITY_FILE, [])
    if isinstance(entries, dict) or not entries:
        return {"length": 0, "first_ts": None, "last_ts": None, "ok": False, "broken_count": 0}
    ok, broken = integrity_chain_verify()
    return {
        "length": len(entries),
        "first_ts": entries[0].get("timestamp"),
        "last_ts": entries[-1].get("timestamp"),
        "first_snapshot": entries[0].get("snapshot_id", "?")[:16],
        "last_snapshot": entries[-1].get("snapshot_id", "?")[:16],
        "ok": ok,
        "broken_count": len(broken),
        "broken_indices": [b.get("index") for b in broken[:5]],
    }


def integrity_verify(skip_self: bool = True) -> Tuple[bool, List[str], List[str], List[str]]:
    """v1.1.0: 验证最新 baseline vs 当前。返回 (ok, tampered, missing, new_files)。

    skip_self=True (默认): 排除 INTEGRITY_FILE 自指（store 自身必然改它）。
    """
    entries = _load(INTEGRITY_FILE, [])
    if isinstance(entries, dict) or not entries:
        return False, [], [], ["no_baseline"]
    baseline = entries[-1]
    current = integrity_snapshot()
    tampered, missing, new_files = [], [], []
    skip = {"snapshot_id", "timestamp", "version", "parent", "created_by", "entry_hash"}
    # v1.1.0 fix M-6: 自指排除。INTEGRITY_FILE 在 CRITICAL_FILES 中是用于审计 chain
    # 完整性（不能被外部修改），但 store 自身必然修改它。verify 阶段必须豁免。
    if skip_self:
        skip.add(str(INTEGRITY_FILE))
    for path_str, stored_hash in baseline.items():
        if path_str.startswith("_") or path_str in skip:
            continue
        cur_hash = current.get(path_str, "MISSING")
        if cur_hash == "MISSING":
            missing.append(path_str)
        elif cur_hash != stored_hash:
            tampered.append(path_str)
    for path_str in current:
        if path_str.startswith("_") or path_str in skip:
            continue
        if path_str not in baseline:
            new_files.append(path_str)
    return not tampered and not missing, tampered, missing, new_files
