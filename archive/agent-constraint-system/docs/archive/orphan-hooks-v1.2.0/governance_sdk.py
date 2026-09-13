#!/usr/bin/env python3
"""
governance_sdk.py — AIOS Governance Runtime SDK (v1.0)
所有 governance tool 的共享基元。防止 verifier spaghetti。

用法:
  from governance_sdk import GovernanceRuntime

  rt = GovernanceRuntime()
  rt.run_verifier("export_graph", ["diff", "--root", str(root)])
  rt.audit_append("merge", {"task_id": "xxx", "files": 3})
  ir = rt.emit_ir(task_id, root)
  rt.validate_ir(ir)
"""

import hashlib
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any


class GovernanceRuntime:
    """
    统一 Runtime SDK。

    提供:
      - 路径解析 (CWD, GOVERNANCE_DIR, AUDIT_DIR, SHADOW_ROOT)
      - verifier 运行 (带统一错误处理、超时、输出解析)
      - 审计日志追加 (append-only, 标准化格式)
      - IR 生成 & 校验
    """

    def __init__(self, cwd: Path = None):
        self.cwd = cwd or Path(os.environ.get("CLAUDE_CWD", os.getcwd())).resolve()
        self.governance_dir = self.cwd / ".claude" / "governance"
        self.audit_dir = self.cwd / ".claude" / "audit"
        self.snapshot_dir = self.cwd / ".claude" / "snapshots"
        self.hooks_dir = self.cwd / ".claude" / "hooks"
        self.shadow_root = Path("/tmp/claude-shadow").resolve()
        self.ir_dir = self.audit_dir / "proposal-ir"

        # 确保目录存在
        for d in [self.audit_dir, self.snapshot_dir, self.ir_dir]:
            os.makedirs(d, exist_ok=True)

    # ================================================================
    # 路径解析
    # ================================================================

    def resolve(self, path: str) -> Path:
        p = Path(path)
        return p.resolve() if p.is_absolute() else (self.cwd / p).resolve()

    def rel(self, path: Path) -> str:
        try:
            return str(path.relative_to(self.cwd))
        except ValueError:
            return str(path)

    # ================================================================
    # Verifier 运行
    # ================================================================

    def run_verifier(self, tool_name: str, args: list, timeout: int = 60) -> dict:
        """
        运行一个 verifier 并返回标准化结果。

        Returns:
          {
            "passed": bool | None,
            "data": dict | None,
            "returncode": int,
            "error": str | None,
            "stderr": str
          }
        """
        tool_path = self.hooks_dir / f"{tool_name}.py"
        if not tool_path.exists():
            return {"passed": None, "data": None, "error": f"Tool not found: {tool_name}"}

        try:
            r = subprocess.run(
                ["python3", str(tool_path)] + args,
                capture_output=True, text=True, timeout=timeout,
                env={**os.environ, "CLAUDE_CWD": str(self.cwd)},
            )
            passed = r.returncode == 0
            data = None
            stdout = r.stdout
            start = stdout.find("{")
            if start >= 0:
                try:
                    data = json.loads(stdout[start:])
                except json.JSONDecodeError:
                    pass
            return {
                "passed": passed,
                "data": data,
                "returncode": r.returncode,
                "stderr": r.stderr[:500],
                "tool": tool_name,
            }
        except subprocess.TimeoutExpired:
            return {"passed": False, "data": None, "error": "Timeout", "tool": tool_name}
        except Exception as e:
            return {"passed": False, "data": None, "error": str(e), "tool": tool_name}

    # ================================================================
    # 审计
    # ================================================================

    def audit_append(self, action: str, payload: dict, log_name: str = "tool-audit.jsonl") -> Path:
        """追加一条审计记录。"""
        log_path = self.audit_dir / log_name
        entry = {
            "timestamp": time.time(),
            "action": action,
            **payload,
        }
        os.makedirs(log_path.parent, exist_ok=True)
        with open(log_path, "a") as f:
            json.dump(entry, f, ensure_ascii=False)
            f.write("\n")
        return log_path

    # ================================================================
    # Hash / Integrity
    # ================================================================

    def hash_file(self, path: Path) -> str:
        if not path.exists():
            return ""
        return hashlib.sha256(path.read_bytes()).hexdigest()[:16]

    def hash_dir(self, root: Path, exclude_dirs: set = None) -> dict:
        exclude = exclude_dirs or {"node_modules", ".git", "dist", "__pycache__"}
        hashes = {}
        for f in sorted(root.rglob("*")):
            if f.is_file() and not any(p in exclude for p in f.parts):
                try:
                    hashes[str(f.relative_to(root))] = self.hash_file(f)
                except Exception:
                    pass
        return hashes

    # ================================================================
    # IR
    # ================================================================

    def emit_ir(self, task_id: str, root: Path,
                proposal_id: str = None, mode: str = "merge") -> dict:
        """生成 Proposal IR（委托给 proposal_ir.py）。"""
        ir_tool = self.hooks_dir / "proposal_ir.py"
        if not ir_tool.exists():
            return {"error": "proposal_ir.py not found"}

        result = self.run_verifier(
            "proposal_ir",
            ["generate", "--task-id", task_id,
             "--proposal-id", proposal_id or f"shadow-merge-{task_id}",
             "--mode", mode, "--root", str(root)],
            timeout=120,
        )
        return result["data"] if result["data"] else {"error": result.get("error", "No data")}

    def validate_ir(self, ir: dict) -> dict:
        """校验 IR 一致性 + schema 合规。"""
        issues = []
        required = ["ir_version", "proposal_id", "generated_at", "task_id",
                    "symbol_changes", "authority_changes", "risk_factors", "governance"]
        for field in required:
            if field not in ir:
                issues.append(f"Missing: {field}")

        if ir.get("ir_version") != "1.1.0":
            issues.append(f"Version mismatch: {ir.get('ir_version')} ≠ 1.1.0")

        valid_cats = {"ABI_BREAK", "ANY_POLLUTION", "STRUCTURAL_DEGRADE",
                      "CAPABILITY_ESCALATION", "TYPE_SAFETY_LOSS",
                      "TOPOLOGY_DRIFT", "SEMANTIC_DEGRADE", "BUDGET_EXCEEDED"}
        for f in ir.get("risk_factors", []):
            if isinstance(f, dict) and f.get("category") not in valid_cats:
                issues.append(f"Invalid category: {f.get('category')}")

        return {"valid": len(issues) == 0, "issues": issues}


# ================================================================
# CLI（独立使用）
# ================================================================

def main():
    import sys
    rt = GovernanceRuntime()
    if len(sys.argv) < 2:
        print(f"SDK ready. CWD={rt.cwd}", file=sys.stderr)
        print(f"  governance_dir: {rt.governance_dir}", file=sys.stderr)
        print(f"  audit_dir: {rt.audit_dir}", file=sys.stderr)
        return

    cmd = sys.argv[1]
    if cmd == "test":
        # 快速自检
        print(json.dumps({
            "cwd": str(rt.cwd),
            "governance": str(rt.governance_dir),
            "audit": str(rt.audit_dir),
            "hooks": str(rt.hooks_dir),
            "dirs_exist": {
                "governance": rt.governance_dir.exists(),
                "audit": rt.audit_dir.exists(),
                "hooks": rt.hooks_dir.exists(),
            }
        }, indent=2, ensure_ascii=False))
    elif cmd == "hash-dir":
        root = Path(sys.argv[2]) if len(sys.argv) > 2 else rt.cwd
        print(json.dumps({"file_count": len(rt.hash_dir(root))}, indent=2))


if __name__ == "__main__":
    main()
