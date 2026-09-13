#!/usr/bin/env python3
"""
shadow_workspace.py — Shadow Workspace Manager (v1.0)
强制 Claude 在隔离环境中工作，不接触真实工程文件。

理念:
  Claude → READ 真实项目
  Claude → WRITE 只能在 shadow workspace
  变更 → verify → risk → approval → atomic merge → 真实项目

用法:
  shadow_workspace.py create <task_id> [--root <dir>]  # 创建 shadow
  shadow_workspace.py diff <task_id> [--root <dir>]     # shadow vs real
  shadow_workspace.py merge <task_id> [--root <dir>]    # verify + risk + apply
  shadow_workspace.py reject <task_id>                  # 丢弃 shadow
  shadow_workspace.py status [--root <dir>]              # 活跃 shadow 列表
"""

# Cursor Agent auto-imports Claude hooks from ~/.claude/settings*.json.
# ACS/ORCH is Claude-only — never gate Cursor sessions.
_e = __import__("os").environ
# Cursor Agent injects CURSOR_PROJECT_DIR / CURSOR_VERSION into hook env (not CURSOR_AGENT).
if _e.get("CURSOR_PROJECT_DIR") or _e.get("CURSOR_VERSION") or _e.get("CURSOR_AGENT"):
    raise SystemExit(0)

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

# ============================================================
# 配置
# ============================================================
CWD = Path(os.environ.get("CLAUDE_CWD", os.getcwd())).resolve()
SHADOW_ROOT = Path("/tmp/claude-shadow").resolve()
DEFAULT_PROJECT_ROOT = CWD / "my-project" / "projects" / "gaokao" / "frontend" / "src"
SNAPSHOT_DIR = CWD / ".claude" / "snapshots"
AUDIT_LOG = CWD / ".claude" / "audit" / "shadow-merge-audit.jsonl"


# 不复制到 shadow 的目录（减少 I/O）
SKIP_COPY_DIRS = {"node_modules", ".git", "dist", "archive", "__pycache__"}


def _shadow_path(task_id: str) -> Path:
    return SHADOW_ROOT / task_id


def _snapshot_path(task_id: str) -> Path:
    return SNAPSHOT_DIR / f"pre-merge-{task_id}.json"


def _hash_file(path: Path) -> str:
    if not path.exists():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def _hash_dir(root: Path) -> dict:
    """递归计算目录哈希"""
    hashes = {}
    for f in sorted(root.rglob("*")):
        if f.is_file() and not any(p in SKIP_COPY_DIRS for p in f.parts):
            try:
                rel = str(f.relative_to(root))
                hashes[rel] = _hash_file(f)
            except Exception:
                pass
    return hashes


# ============================================================
# 命令: create
# ============================================================

def cmd_create(task_id: str, project_root: Path):
    shadow = _shadow_path(task_id)
    if shadow.exists():
        print(f"[SHADOW] Already exists: {shadow}", file=sys.stderr)
        print(f"[SHADOW] Use 'merge' or 'reject' first, or choose a different task_id", file=sys.stderr)
        sys.exit(1)

    # 确保 SHADOW_ROOT 存在
    os.makedirs(SHADOW_ROOT, exist_ok=True)
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    os.makedirs(AUDIT_LOG.parent, exist_ok=True)

    print(f"[SHADOW] Creating shadow workspace for task: {task_id}", file=sys.stderr)
    print(f"[SHADOW] Source: {project_root}", file=sys.stderr)
    print(f"[SHADOW] Shadow: {shadow}", file=sys.stderr)

    # 复制项目到 shadow（跳过排除目录）
    file_count = 0
    for src_file in project_root.rglob("*"):
        if src_file.is_dir():
            continue
        if any(p in SKIP_COPY_DIRS for p in src_file.parts):
            continue
        rel = src_file.relative_to(project_root)
        dst = shadow / rel
        try:
            os.makedirs(dst.parent, exist_ok=True)
            shutil.copy2(src_file, dst)
            file_count += 1
        except Exception as e:
            print(f"[SHADOW] Warning: failed to copy {rel}: {e}", file=sys.stderr)

    # 记录元数据
    meta = {
        "task_id": task_id,
        "created_at": time.time(),
        "project_root": str(project_root),
        "shadow_path": str(shadow),
        "file_count": file_count,
        "source_hashes": _hash_dir(project_root),
        "status": "created",
    }
    with open(shadow / ".shadow_meta.json", "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    print(f"[SHADOW] Created: {file_count} files in {shadow}", file=sys.stderr)
    print(f"\n[SNAPSHOT] Baseline snapshot: {file_count} files hashed", file=sys.stderr)
    print(f"[SHADOW] Claude workspace ready: {shadow}", file=sys.stderr)

    # ==== 自动 Pin Governance Baseline ====
    proposal_ir_path = CWD / ".claude" / "hooks" / "proposal_ir.py"
    if proposal_ir_path.exists():
        try:
            merge_pid = f"shadow-merge-{task_id}"
            subprocess.run(
                ["python3", str(proposal_ir_path), "pin",
                 "--task-id", task_id, "--proposal-id", merge_pid],
                capture_output=True, timeout=30,
                env={**os.environ, "CLAUDE_CWD": str(CWD)},
            )
            print(f"[PIN] Governance baseline pinned for task: {task_id}", file=sys.stderr)
        except Exception as e:
            print(f"[PIN] Warning: failed to pin baseline: {e}", file=sys.stderr)


# ============================================================
# 命令: diff
# ============================================================

def cmd_diff(task_id: str, project_root: Path):
    shadow = _shadow_path(task_id)
    if not shadow.exists():
        print(f"[SHADOW] Shadow not found: {task_id}", file=sys.stderr)
        sys.exit(1)

    # 对比 hash
    source_hashes = _hash_dir(project_root)
    shadow_hashes = _hash_dir(shadow)

    all_files = set(source_hashes.keys()) | set(shadow_hashes.keys())

    changes = {"added": [], "modified": [], "deleted": [], "unchanged": 0}

    for rel in sorted(all_files):
        # 跳过 shadow meta
        if rel.endswith(".shadow_meta.json"):
            continue
        sh = source_hashes.get(rel, "")
        dh = shadow_hashes.get(rel, "")
        if not sh and dh:
            changes["added"].append(rel)
        elif sh and not dh:
            changes["deleted"].append(rel)
        elif sh != dh:
            changes["modified"].append(rel)
        else:
            changes["unchanged"] += 1

    changes["summary"] = {
        "added": len(changes["added"]),
        "modified": len(changes["modified"]),
        "deleted": len(changes["deleted"]),
        "unchanged": changes["unchanged"],
        "total_changed": len(changes["added"]) + len(changes["modified"]) + len(changes["deleted"]),
    }

    print(json.dumps(changes, indent=2, ensure_ascii=False))
    return changes


# ============================================================
# 命令: merge (verify + risk + apply)
# ============================================================

def cmd_merge(task_id: str, project_root: Path, force: bool = False):
    shadow = _shadow_path(task_id)
    if not shadow.exists():
        print(f"[SHADOW] Shadow not found: {task_id}", file=sys.stderr)
        sys.exit(1)

    # ==== Step 0: Acquire Merge Lock ====
    state_store = CWD / ".claude" / "hooks" / "state_store.py"
    merge_pid = f"shadow-merge-{task_id}"
    lock_acquired = False
    if state_store.exists():
        try:
            r = subprocess.run(
                ["python3", str(state_store), "lock", merge_pid],
                capture_output=True, text=True, timeout=10,
            )
            if r.returncode == 0:
                lock_acquired = True
                print(f"[LOCK] Merge lock acquired: {merge_pid}", file=sys.stderr)
            else:
                print(f"[LOCK] Cannot acquire merge lock — another merge in progress?", file=sys.stderr)
                if not force:
                    print(f"[SHADOW] Merge BLOCKED by lock", file=sys.stderr)
                    sys.exit(2)
        except Exception as e:
            print(f"[LOCK] Warning: {e}", file=sys.stderr)

    changes = cmd_diff(task_id, project_root)

    if changes["summary"]["total_changed"] == 0:
        print(f"[SHADOW] No changes to merge", file=sys.stderr)
        return

    # ==== Step 1: Snapshot (pre-merge) ====
    pre_snapshot = {"task_id": task_id, "timestamp": time.time(), "type": "pre-merge",
                    "source_hashes": _hash_dir(project_root), "changes": changes}
    snapshot_file = _snapshot_path(task_id)
    with open(snapshot_file, "w") as f:
        json.dump(pre_snapshot, f, indent=2, ensure_ascii=False)
    print(f"[SNAPSHOT] Pre-merge snapshot: {snapshot_file}", file=sys.stderr)

    # ==== Step 2: Unified Proposal IR ====
    print(f"\n[VERIFY] Generating Proposal IR...", file=sys.stderr)
    proposal_ir_path = CWD / ".claude" / "hooks" / "proposal_ir.py"
    verify_results = {}
    risk_result = {"score": 0, "level": "AUTO"}

    if proposal_ir_path.exists():
        try:
            r = subprocess.run(
                ["python3", str(proposal_ir_path), "generate",
                 "--task-id", task_id, "--proposal-id", f"shadow-merge-{task_id}",
                 "--root", str(project_root)],
                capture_output=True, text=True, timeout=120,
                env={**os.environ, "CLAUDE_CWD": str(CWD)},
            )
            # IR 输出在 stdout 的 JSON 部分
            stdout = r.stdout
            start = stdout.find("{")
            ir_data = {}
            if start >= 0:
                ir_data = json.loads(stdout[start:])

            gov = ir_data.get("governance", {})
            risk_result = {"score": gov.get("severity_score", 0), "level": gov.get("level", "AUTO")}
            verify_results = {
                "proposal_ir": "PASS" if r.returncode == 0 else "FAIL",
                "symbol_changes": "PASS" if ir_data.get("symbol_changes", {}).get("_verifier_passed") else "FAIL",
                "authority_changes": "PASS" if ir_data.get("authority_changes", {}).get("_verifier_passed") else "FAIL",
                "ir_file": str(ir_data.get("summary", {})) if ir_data else str(r.stderr[:200]),
            }
            print(f"[VERIFY] IR Level: {gov.get('level', '?')} | "
                  f"Factors: {len(ir_data.get('risk_factors', []))} | "
                  f"Return: {r.returncode}", file=sys.stderr)

            if r.returncode != 0 and not force:
                print(f"[SHADOW] Merge BLOCKED by Proposal IR (level: {gov.get('level', '?')})", file=sys.stderr)
                sys.exit(2)
        except Exception as e:
            verify_results["proposal_ir"] = {"error": str(e)}
            print(f"[VERIFY] Proposal IR error: {e}", file=sys.stderr)
    else:
        print(f"[VERIFY] Proposal IR not available, skipping verification", file=sys.stderr)

    # ==== Step 4: Atomic Merge ====
    print(f"\n[MERGE] Applying {changes['summary']['total_changed']} changes...", file=sys.stderr)
    merged = 0
    errors = 0

    # 新增/修改文件
    for rel in changes["added"] + changes["modified"]:
        src = shadow / rel
        dst = project_root / rel
        try:
            os.makedirs(dst.parent, exist_ok=True)
            # Atomic: write to temp → rename
            tmp = dst.with_suffix(dst.suffix + ".merge_tmp")
            tmp.write_bytes(src.read_bytes())
            os.replace(tmp, dst)  # atomic on POSIX
            merged += 1
        except Exception as e:
            print(f"[MERGE] Error: {rel}: {e}", file=sys.stderr)
            errors += 1

    # 删除文件
    for rel in changes["deleted"]:
        dst = project_root / rel
        try:
            if dst.exists():
                dst.unlink()
            merged += 1
        except Exception as e:
            print(f"[MERGE] Error deleting: {rel}: {e}", file=sys.stderr)
            errors += 1

    print(f"[MERGE] Applied: {merged} files, {errors} errors", file=sys.stderr)

    # ==== Step 5: Post-merge Snapshot ====
    post_snapshot = {"task_id": task_id, "timestamp": time.time(), "type": "post-merge",
                     "source_hashes": _hash_dir(project_root), "merged_count": merged, "errors": errors}
    with open(snapshot_file.with_name(f"post-merge-{task_id}.json"), "w") as f:
        json.dump(post_snapshot, f, indent=2, ensure_ascii=False)

    # ==== Step 6: Audit ====
    audit_entry = {"timestamp": time.time(), "task_id": task_id, "action": "merge",
                   "changes": changes["summary"], "verify": verify_results,
                   "risk": {"score": risk_result.get("score"), "level": risk_result.get("level")},
                   "merged": merged, "errors": errors}
    with open(AUDIT_LOG, "a") as f:
        json.dump(audit_entry, f)
        f.write("\n")

    print(f"\n[AUDIT] Merge recorded: {AUDIT_LOG}", file=sys.stderr)

    # ==== Step 7: Cleanup ====
    shutil.rmtree(shadow, ignore_errors=True)
    print(f"[SHADOW] Cleaned up: {shadow}", file=sys.stderr)

    # ==== Step 8: Release Lock ====
    if lock_acquired and state_store.exists():
        subprocess.run(
            ["python3", str(state_store), "unlock", merge_pid],
            capture_output=True, timeout=10,
        )
        print(f"[LOCK] Merge lock released: {merge_pid}", file=sys.stderr)

    return audit_entry


# ============================================================
# 命令: reject
# ============================================================

def cmd_reject(task_id: str):
    shadow = _shadow_path(task_id)
    if not shadow.exists():
        print(f"[SHADOW] Shadow not found: {task_id}", file=sys.stderr)
        sys.exit(1)

    shutil.rmtree(shadow, ignore_errors=True)
    print(f"[SHADOW] Rejected and removed: {task_id}", file=sys.stderr)

    # Audit
    with open(AUDIT_LOG, "a") as f:
        json.dump({"timestamp": time.time(), "task_id": task_id, "action": "reject"}, f)
        f.write("\n")


# ============================================================
# 命令: status
# ============================================================

def cmd_status():
    shadows = []
    if SHADOW_ROOT.exists():
        for d in SHADOW_ROOT.iterdir():
            if d.is_dir():
                meta_file = d / ".shadow_meta.json"
                if meta_file.exists():
                    try:
                        meta = json.load(meta_file.read_text())
                        shadows.append({
                            "task_id": meta["task_id"],
                            "created_at": meta["created_at"],
                            "file_count": meta["file_count"],
                            "status": meta.get("status", "unknown"),
                        })
                    except Exception:
                        pass

    print(json.dumps({"active_shadows": shadows, "shadow_root": str(SHADOW_ROOT)}, indent=2))
    if shadows:
        print(f"\n[SHADOW] {len(shadows)} active shadow workspace(s)", file=sys.stderr)
    else:
        print(f"\n[SHADOW] No active shadows", file=sys.stderr)


# ============================================================
# 入口
# ============================================================

def main():
    if len(sys.argv) < 2:
        print("Usage: shadow_workspace.py <create|diff|merge|reject|status> [task_id] [--root <dir>] [--force]",
              file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    root = DEFAULT_PROJECT_ROOT
    force = "--force" in sys.argv

    for i, arg in enumerate(sys.argv):
        if arg == "--root" and i + 1 < len(sys.argv):
            root = Path(sys.argv[i + 1]).resolve()

    task_id = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith("--") else None

    if cmd == "status":
        cmd_status()
    elif cmd == "reject":
        if not task_id:
            print("Missing task_id", file=sys.stderr)
            sys.exit(1)
        cmd_reject(task_id)
    elif cmd in ("create", "diff", "merge"):
        if not task_id:
            print("Missing task_id", file=sys.stderr)
            sys.exit(1)
        if not root.exists():
            print(f"[SHADOW] Project root not found: {root}", file=sys.stderr)
            sys.exit(1)
        if cmd == "create":
            cmd_create(task_id, root)
        elif cmd == "diff":
            cmd_diff(task_id, root)
        elif cmd == "merge":
            cmd_merge(task_id, root, force=force)
    else:
        print(f"Unknown: {cmd}", file=sys.stderr)
        sys.exit(1)


def _hook_safe_entry():
    """ACS PreToolUse hook 安全入口 — 无参数时默认 status 模式静默退出。"""
    try:
        import sys
        if len(sys.argv) < 2:
            sys.argv = [sys.argv[0], "status", "--root", os.path.expanduser("~/.claude")]
        main()
    except SystemExit:
        pass

if __name__ == "__main__":
    _hook_safe_entry()
