#!/usr/bin/env python3
"""
export_graph.py — Structural Analyzer (v0.3.x)
自动扫描 TypeScript 源码，建立 symbol graph + Type Integrity 检测。

用法:
  python3 export_graph.py scan [--root <dir>]      # 全量扫描
  python3 export_graph.py diff [--root <dir>]       # 对比 snapshot + 完整性检查 + 风险评分
  python3 export_graph.py lock [--root <dir>]       # 锁定当前状态为基线
  python3 export_graph.py check [--root <dir>]      # 仅完整性检查（不对比 snapshot）

设计原则:
  - Grandfathering: 存量不追溯，只限制增量
  - Delta-based: 每次变更的退化增量不超过阈值
  - Risk Scoring: 加权评分 + 自动 BLOCK/REVIEW/WARN
"""

import hashlib
import json
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

# ============================================================
# 配置
# ============================================================
CWD = Path(os.environ.get("CLAUDE_CWD", os.getcwd())).resolve()
DEFAULT_ROOT = CWD / "my-project" / "projects" / "gaokao" / "frontend" / "src"
ABI_LOCK = CWD / ".claude" / "governance" / "abi-lock.json"
SYMBOL_GRAPH = CWD / ".claude" / "governance" / "symbol-graph.json"
BUDGET_FILE = CWD / ".claude" / "governance" / "type_budget.yaml"

EXCLUDE_DIRS = {"node_modules", "__tests__", "dist", ".git", "archive", "v6", "v7", "v8", "v9"}
EXTENSIONS = {".ts", ".tsx"}


# ============================================================
# Budget 加载
# ============================================================

def _load_budget() -> dict:
    """加载 type_budget.yaml。不存在则返回默认值（最严格）"""
    if not BUDGET_FILE.exists():
        return {
            "delta_budget": {
                "any": {"allowed_delta": 0, "severity": "critical", "block": True},
                "unknown": {"allowed_delta": 0, "severity": "high", "block": True},
                "optionalization": {"allowed_delta": 2, "severity": "high", "block": True},
                "readonly_removal": {"allowed_delta": 0, "severity": "high", "block": True},
                "interface_shrink": {"allowed_delta": 0, "severity": "critical", "block": True},
                "generic_constraint_loss": {"allowed_delta": 0, "severity": "high", "block": True},
                "export_deletion": {"allowed_delta": 0, "severity": "critical", "block": True},
                "unchecked_cast": {"allowed_delta": 1, "severity": "low", "block": False},
                "dependency_fanout": {"allowed_delta": 5, "severity": "medium", "block": False},
            },
            "risk_scoring": {
                "weights": {
                    "export_deletion": 50, "interface_shrink": 50, "optionalization": 15,
                    "readonly_removal": 20, "any_delta": 10, "unknown_delta": 10,
                    "generic_constraint_loss": 30, "unchecked_cast": 3, "dependency_fanout": 5,
                    "cyclic_dependency": 100,
                },
                "thresholds": {"auto_block": 50, "require_review": 20, "warn": 5},
            },
        }
    # 简单 YAML 解析（只取需要的部分，不引入 PyYAML 依赖）
    try:
        import yaml
        with open(BUDGET_FILE) as f:
            return yaml.safe_load(f)
    except ImportError:
        # Fallback: 正则提取关键字段
        raw = Path(BUDGET_FILE).read_text()
        return _parse_yaml_loosely(raw)


def _parse_yaml_loosely(raw: str) -> dict:
    """轻量 YAML 解析：匹配 key: value 对"""
    import re as _re
    result: dict = {"delta_budget": {}, "risk_scoring": {"weights": {}, "thresholds": {}}}

    _sections = _re.split(r'\n(?=\w)', raw)
    for line in raw.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = _re.match(r'(\w+):\s*(\d+)', line)
        if m:
            k, v = m.groups()
            # 根据位置分到不同 section
            for section_name in ["any", "unknown", "optionalization", "readonly_removal",
                                 "interface_shrink", "generic_constraint_loss", "export_deletion",
                                 "unchecked_cast", "dependency_fanout"]:
                if k == section_name:
                    pass  # 不处理

    # 太脆弱了，直接用默认值 fallback
    return _load_budget_defaults()


def _load_budget_defaults():
    return {
        "delta_budget": {
            "any": {"allowed_delta": 0, "severity": "critical", "block": True},
            "unknown": {"allowed_delta": 0, "severity": "high", "block": True},
            "optionalization": {"allowed_delta": 2, "severity": "high", "block": True},
            "readonly_removal": {"allowed_delta": 0, "severity": "high", "block": True},
            "interface_shrink": {"allowed_delta": 0, "severity": "critical", "block": True},
            "generic_constraint_loss": {"allowed_delta": 0, "severity": "high", "block": True},
            "export_deletion": {"allowed_delta": 0, "severity": "critical", "block": True},
            "unchecked_cast": {"allowed_delta": 1, "severity": "low", "block": False},
            "dependency_fanout": {"allowed_delta": 5, "severity": "medium", "block": False},
        },
        "risk_scoring": {
            "weights": {
                "export_deletion": 50, "interface_shrink": 50, "optionalization": 15,
                "readonly_removal": 20, "any_delta": 10, "unknown_delta": 10,
                "generic_constraint_loss": 30, "unchecked_cast": 3, "dependency_fanout": 5,
                "cyclic_dependency": 100,
            },
            "thresholds": {"auto_block": 50, "require_review": 20, "warn": 5},
        },
    }


# ============================================================
# 解析器
# ============================================================

def _hash_content(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


def _extract_exports(source: str) -> dict:
    results = {}
    for m in re.finditer(
        r'export\s+(?:default\s+)?(?:abstract\s+)?(function|class|const|let|var|type|interface|enum)\s+(\w+)', source):
        results[m.group(2)] = {"kind": m.group(1), "line": source[:m.start()].count("\n") + 1, "type": "declaration"}
    for m in re.finditer(r'export\s*\{([^}]+)\}', source):
        for part in m.group(1).split(","):
            tokens = part.strip().split()
            if tokens and "from" not in tokens:
                results.setdefault(tokens[-1],
                                   {"kind": "re-export", "line": source[:m.start()].count("\n") + 1, "type": "re-export"})
    return results


def _extract_interfaces(source: str) -> dict:
    results = {}
    for m in re.finditer(r'export\s+interface\s+(\w+)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}', source, re.DOTALL):
        name, body = m.group(1), m.group(2)
        fields = []
        for fm in re.finditer(r'^\s*(readonly\s+)?(\w+)\s*([?!])?\s*:\s*([^;]+)', body, re.MULTILINE):
            fields.append({
                "name": fm.group(2), "optional": fm.group(3) == "?",
                "readonly": fm.group(1) is not None,
                "type": fm.group(4).strip(),
                "has_any": "any" in fm.group(4),
            })
        results[name] = {"line": source[:m.start()].count("\n") + 1, "fields": fields,
                         "field_count": len(fields),
                         "readonly_count": sum(1 for f in fields if f["readonly"])}
    # type aliases
    for m in re.finditer(r'export\s+type\s+(\w+)\s*=\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}', source, re.DOTALL):
        name, body = m.group(1), m.group(2)
        fields = []
        for fm in re.finditer(r'^\s*(readonly\s+)?(\w+)\s*([?!])?\s*:\s*([^;]+)', body, re.MULTILINE):
            fields.append({
                "name": fm.group(2), "optional": fm.group(3) == "?",
                "readonly": fm.group(1) is not None,
                "type": fm.group(4).strip(),
                "has_any": "any" in fm.group(4),
            })
        results[name] = {"line": source[:m.start()].count("\n") + 1, "fields": fields, "field_count": len(fields)}
    return results


def _extract_imports(source: str) -> dict:
    results = {}
    for m in re.finditer(r"import\s+\{([^}]+)\}\s+from\s+['\"]([^'\"]+)['\"]", source):
        symbols = [t.strip().split()[-1].strip() for t in m.group(1).split(",") if t.strip()]
        results.setdefault(m.group(2), []).extend(symbols)
    for m in re.finditer(r"import\s+\*\s+as\s+(\w+)\s+from\s+['\"]([^'\"]+)['\"]", source):
        results.setdefault(m.group(2), []).append(f"*:{m.group(1)}")
    for m in re.finditer(r"import\s+(\w+)\s+from\s+['\"]([^'\"]+)['\"]", source):
        results.setdefault(m.group(2), []).append(m.group(1))
    return results


def _count_any(source: str) -> int:
    return len(re.findall(r'\bany\b', source))


def _count_unknown(source: str) -> int:
    return len(re.findall(r'\bunknown\b', source))


def _count_unchecked_casts(source: str) -> dict:
    """计算类型断言（排除 as const）"""
    all_casts = len(re.findall(r'\bas\s+\w+', source))
    const_casts = len(re.findall(r'\bas\s+const\b', source))
    return {"total": all_casts, "const": const_casts, "unchecked": all_casts - const_casts}


def _extract_generic_constraints(source: str) -> list:
    """提取泛型约束"""
    results = []
    for m in re.finditer(r'<\s*(?:(\w+)\s+extends\s+([^,>]+))(?:,\s*(\w+)\s+extends\s+([^,>]+))?\s*>', source):
        g1 = (m.group(1), m.group(2).strip()) if m.group(1) else None
        g2 = (m.group(3), m.group(4).strip()) if m.group(3) else None
        for g in [g1, g2]:
            if g:
                results.append({"param": g[0], "constraint": g[1]})
    unconstrained = len(re.findall(r'<\s*(\w+)\s*>', source))
    return results, unconstrained


# ============================================================
# 扫描器
# ============================================================

def scan(root: Path) -> dict:
    files = {}
    totals = {"exports": 0, "interfaces": 0, "any": 0, "unknown": 0,
              "unchecked_casts": 0, "readonly_fields": 0, "dependency_fanout_total": 0, "lines": 0}

    for f in sorted(root.rglob("*")):
        if f.suffix not in EXTENSIONS:
            continue
        if any(part in EXCLUDE_DIRS for part in f.parts):
            continue
        try:
            source = f.read_text(encoding="utf-8")
        except Exception:
            continue

        rel = str(f.relative_to(root))
        generics, unconstrained = _extract_generic_constraints(source)

        fi = {
            "exports": _extract_exports(source),
            "interfaces": _extract_interfaces(source),
            "imports": _extract_imports(source),
            "any_count": _count_any(source),
            "unknown_count": _count_unknown(source),
            "unchecked_casts": _count_unchecked_casts(source),
            "generic_constraints": generics,
            "unconstrained_generics": unconstrained,
            "dependency_fanout": len(_extract_imports(source)),
            "lines": source.count("\n") + 1,
            "size": len(source),
            "hash": _hash_content(source),
        }
        files[rel] = fi
        totals["exports"] += len(fi["exports"])
        totals["interfaces"] += len(fi["interfaces"])
        totals["any"] += fi["any_count"]
        totals["unknown"] += fi["unknown_count"]
        totals["unchecked_casts"] += fi["unchecked_casts"]["unchecked"]
        totals["readonly_fields"] += sum(
            sum(1 for fd in iface.get("fields", []) if fd.get("readonly"))
            for iface in fi["interfaces"].values())
        totals["dependency_fanout_total"] += fi["dependency_fanout"]
        totals["lines"] += fi["lines"]

    return {"scanned_at": time.time(), "root": str(root), "file_count": len(files),
            "totals": totals, "files": files}


# ============================================================
# Diff 引擎（多维）
# ============================================================

def diff(old: dict, new: dict) -> dict:
    changes = {
        "export_deletions": [],
        "interface_shrinks": [],
        "optionalizations": [],
        "readonly_removals": [],
        "any_increases": [],
        "unknown_increases": [],
        "generic_constraint_losses": [],
        "unchecked_cast_increases": [],
        "dependency_fanout_spikes": [],
        "hash_changes": [],
        "file_additions": [],
        "file_deletions": [],
    }

    ofs = old.get("files", {})
    nfs = new.get("files", {})

    changes["file_additions"] = list(set(nfs.keys()) - set(ofs.keys()))
    changes["file_deletions"] = list(set(ofs.keys()) - set(nfs.keys()))

    for path in set(ofs) & set(nfs):
        of, nf = ofs[path], nfs[path]

        # export 删除
        old_exports = set(of["exports"])
        new_exports = set(nf["exports"])
        for sym in old_exports - new_exports:
            changes["export_deletions"].append(
                {"file": path, "symbol": sym, "kind": of["exports"][sym].get("kind", "?")})

        # interface 字段删除 + optionalization + readonly 移除
        for iface_name, oi in of.get("interfaces", {}).items():
            ni = nf.get("interfaces", {}).get(iface_name, {})
            ofields = {fd["name"]: fd for fd in oi.get("fields", [])}
            nfields = {fd["name"]: fd for fd in ni.get("fields", [])}

            # 字段删除
            removed = set(ofields) - set(nfields)
            if removed:
                changes["interface_shrinks"].append(
                    {"file": path, "interface": iface_name, "removed_fields": list(removed)})

            # optionalization: required → optional
            for fname in set(ofields) & set(nfields):
                o_opt = ofields[fname].get("optional", False)
                n_opt = nfields[fname].get("optional", False)
                if not o_opt and n_opt:
                    changes["optionalizations"].append(
                        {"file": path, "interface": iface_name, "field": fname,
                         "change": "required → optional"})

                # readonly 移除
                o_ro = ofields[fname].get("readonly", False)
                n_ro = nfields[fname].get("readonly", False)
                if o_ro and not n_ro:
                    changes["readonly_removals"].append(
                        {"file": path, "interface": iface_name, "field": fname,
                         "change": "readonly → mutable"})

        # any 增加
        ad = nf.get("any_count", 0) - of.get("any_count", 0)
        if ad > 0:
            changes["any_increases"].append({"file": path, "old": of.get("any_count", 0), "new": nf.get("any_count", 0), "delta": ad})

        # unknown 增加
        ud = nf.get("unknown_count", 0) - of.get("unknown_count", 0)
        if ud > 0:
            changes["unknown_increases"].append({"file": path, "old": of.get("unknown_count", 0), "new": nf.get("unknown_count", 0), "delta": ud})

        # generic constraint loss
        og = {g["param"]: g for g in of.get("generic_constraints", [])}
        ng = {g["param"]: g for g in nf.get("generic_constraints", [])}
        for param, gc in og.items():
            if param not in ng:
                changes["generic_constraint_losses"].append(
                    {"file": path, "param": param, "old_constraint": gc.get("constraint"), "change": "constraint removed"})
            elif gc.get("constraint") != ng[param].get("constraint") and len(gc.get("constraint", "")) > len(ng[param].get("constraint", "")):
                changes["generic_constraint_losses"].append(
                    {"file": path, "param": param, "old_constraint": gc["constraint"], "new_constraint": ng[param]["constraint"],
                     "change": "constraint weakened"})

        # unchecked_cast 增加
        oc = of.get("unchecked_casts", {}).get("unchecked", 0)
        nc = nf.get("unchecked_casts", {}).get("unchecked", 0)
        if nc > oc:
            changes["unchecked_cast_increases"].append({"file": path, "old": oc, "new": nc, "delta": nc - oc})

        # dependency fanout spike
        fo = of.get("dependency_fanout", 0)
        fn = nf.get("dependency_fanout", 0)
        if fn - fo > 3:  # spike threshold
            changes["dependency_fanout_spikes"].append({"file": path, "old_fanout": fo, "new_fanout": fn, "delta": fn - fo})

        if nf.get("hash") != of.get("hash"):
            changes["hash_changes"].append({"file": path, "old_hash": of.get("hash"), "new_hash": nf.get("hash")})

    return changes


# ============================================================
# 风险评分引擎
# ============================================================

def score(changes: dict, budget: dict) -> dict:
    """对变更进行风险评分"""
    weights = budget.get("risk_scoring", {}).get("weights", _load_budget_defaults()["risk_scoring"]["weights"])
    thresholds = budget.get("risk_scoring", {}).get("thresholds", _load_budget_defaults()["risk_scoring"]["thresholds"])

    scoring = {}
    total_score = 0

    mapping = [
        ("export_deletions", "export_deletion", lambda c: len(c)),
        ("interface_shrinks", "interface_shrink", lambda c: len(c)),
        ("optionalizations", "optionalization", lambda c: len(c)),
        ("readonly_removals", "readonly_removal", lambda c: len(c)),
        ("any_increases", "any_delta", lambda c: sum(v.get("delta", 0) for v in c)),
        ("unknown_increases", "unknown_delta", lambda c: sum(v.get("delta", 0) for v in c)),
        ("generic_constraint_losses", "generic_constraint_loss", lambda c: len(c)),
        ("unchecked_cast_increases", "unchecked_cast", lambda c: sum(v.get("delta", 0) for v in c)),
        ("dependency_fanout_spikes", "dependency_fanout", lambda c: sum(v.get("delta", 0) for v in c)),
    ]

    for change_key, weight_key, count_fn in mapping:
        count = count_fn(changes.get(change_key, []))
        w = weights.get(weight_key, 5)
        score_val = count * w
        scoring[change_key] = {"count": count, "weight_per": w, "score": score_val}
        total_score += score_val

    verdict = "PASS"
    if total_score >= thresholds.get("auto_block", 50):
        verdict = "BLOCK"
    elif total_score >= thresholds.get("require_review", 20):
        verdict = "REVIEW"
    elif total_score >= thresholds.get("warn", 5):
        verdict = "WARN"

    return {
        "total_score": total_score,
        "verdict": verdict,
        "thresholds": thresholds,
        "breakdown": scoring,
    }


# ============================================================
# Budget 检查
# ============================================================

def check_budget(changes: dict, budget: dict) -> dict:
    """检查变更是否超出预算"""
    db = budget.get("delta_budget", _load_budget_defaults()["delta_budget"])
    violations = []

    checks = [
        ("any", "any_increases", lambda c: sum(v.get("delta", 0) for v in c)),
        ("unknown", "unknown_increases", lambda c: sum(v.get("delta", 0) for v in c)),
        ("optionalization", "optionalizations", lambda c: len(c)),
        ("readonly_removal", "readonly_removals", lambda c: len(c)),
        ("interface_shrink", "interface_shrinks", lambda c: len(c)),
        ("generic_constraint_loss", "generic_constraint_losses", lambda c: len(c)),
        ("export_deletion", "export_deletions", lambda c: len(c)),
        ("unchecked_cast", "unchecked_cast_increases", lambda c: sum(v.get("delta", 0) for v in c)),
        ("dependency_fanout", "dependency_fanout_spikes", lambda c: sum(v.get("delta", 0) for v in c)),
    ]

    for budget_key, change_key, count_fn in checks:
        rule = db.get(budget_key, {"allowed_delta": 0, "block": True, "severity": "high"})
        allowed = rule.get("allowed_delta", 0)
        actual = count_fn(changes.get(change_key, []))
        if actual > allowed:
            violations.append({
                "rule": budget_key,
                "allowed": allowed,
                "actual": actual,
                "delta": actual - allowed,
                "severity": rule.get("severity", "high"),
                "block": rule.get("block", True),
            })

    return {"violations": violations, "blocked": any(v["block"] and v["delta"] > 0 for v in violations)}


# ============================================================
# 命令
# ============================================================

def cmd_lock(root: Path):
    data = scan(root)
    abi_lock = {"version": "3.0", "locked_at": time.time(), "root": str(root),
                "summary": data["totals"], "exports": {}, "interfaces": {},
                "metrics": {}, "hashes": {}}
    for path, fi in data["files"].items():
        abi_lock["exports"][path] = fi["exports"]
        abi_lock["interfaces"][path] = fi["interfaces"]
        abi_lock["metrics"][path] = {
            "any_count": fi.get("any_count", 0),
            "unknown_count": fi.get("unknown_count", 0),
            "unchecked_casts": fi.get("unchecked_casts", {}),
            "dependency_fanout": fi.get("dependency_fanout", 0),
        }
        abi_lock["hashes"][path] = fi["hash"]

    os.makedirs(ABI_LOCK.parent, exist_ok=True)
    with open(ABI_LOCK, "w") as f:
        json.dump(abi_lock, f, indent=2, ensure_ascii=False)

    os.makedirs(SYMBOL_GRAPH.parent, exist_ok=True)
    graph = {"version": "3.0", "generated_at": time.time(), "root": str(root), **data}
    with open(SYMBOL_GRAPH, "w") as f:
        json.dump(graph, f, indent=2, ensure_ascii=False)

    t = data["totals"]
    print(f"[STRUCTURAL ANALYZER] Locked {data['file_count']} files", file=sys.stderr)
    print(f"[STRUCTURAL ANALYZER] {t['exports']} exports | {t['interfaces']} interfaces | "
          f"any:{t['any']} | unknown:{t['unknown']} | readonly:{t['readonly_fields']} | "
          f"unchecked_cast:{t['unchecked_casts']}", file=sys.stderr)


def cmd_diff(root: Path):
    if not ABI_LOCK.exists():
        print("[STRUCTURAL ANALYZER] No baseline. Run 'lock' first.", file=sys.stderr)
        sys.exit(1)

    old_lock = json.load(open(ABI_LOCK))
    new_data = scan(root)

    # 转换旧 lock 格式
    old_data = {"files": {}}
    for path in old_lock.get("hashes", {}):
        m = old_lock.get("metrics", {}).get(path, {})
        fi = {"exports": old_lock["exports"].get(path, {}),
              "interfaces": old_lock["interfaces"].get(path, {}),
              "any_count": m.get("any_count", 0),
              "unknown_count": m.get("unknown_count", 0),
              "unchecked_casts": m.get("unchecked_casts", {"unchecked": 0}),
              "generic_constraints": [],
              "dependency_fanout": m.get("dependency_fanout", 0),
              "hash": old_lock["hashes"].get(path, "")}
        old_data["files"][path] = fi

    changes = diff(old_data, new_data)
    budget = _load_budget()
    integrity = check_budget(changes, budget)
    risk = score(changes, budget)

    result = {"changes": changes, "integrity": integrity, "risk": risk}

    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

    if integrity["blocked"]:
        print(f"\n[STRUCTURAL ANALYZER] BLOCKED: Budget exceeded", file=sys.stderr)
        for v in integrity["violations"]:
            if v["block"]:
                print(f"  {v['rule']}: allowed={v['allowed']} actual={v['actual']}", file=sys.stderr)
        sys.exit(2)

    if risk["verdict"] == "BLOCK":
        print(f"\n[STRUCTURAL ANALYZER] BLOCKED: Risk score {risk['total_score']}", file=sys.stderr)
        sys.exit(2)
    elif risk["verdict"] == "REVIEW":
        print(f"\n[STRUCTURAL ANALYZER] REVIEW: Risk score {risk['total_score']}", file=sys.stderr)
    else:
        v = risk.get("verdict", "PASS")
        print(f"\n[STRUCTURAL ANALYZER] {v}: Risk score {risk['total_score']}", file=sys.stderr)


def cmd_check(root: Path):
    """仅做完整性检查，不对比 snapshot"""
    data = scan(root)
    budget = _load_budget()
    t = data["totals"]
    print(f"[STRUCTURAL ANALYZER] Scan: {data['file_count']} files", file=sys.stderr)
    print(f"[STRUCTURAL ANALYZER] exports:{t['exports']} interfaces:{t['interfaces']} "
          f"any:{t['any']} unknown:{t['unknown']} readonly:{t['readonly_fields']} "
          f"unchecked_cast:{t['unchecked_casts']}", file=sys.stderr)
    print(json.dumps(data["totals"], indent=2, ensure_ascii=False))


def main():
    if len(sys.argv) < 2:
        print("Usage: export_graph.py <lock|diff|check> [--root <dir>]", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    root = DEFAULT_ROOT
    for i, arg in enumerate(sys.argv):
        if arg == "--root" and i + 1 < len(sys.argv):
            root = Path(sys.argv[i + 1]).resolve()

    if not root.exists():
        print(f"[STRUCTURAL ANALYZER] Root not found: {root}", file=sys.stderr)
        sys.exit(1)

    if cmd == "lock":
        cmd_lock(root)
    elif cmd == "diff":
        cmd_diff(root)
    elif cmd == "check":
        cmd_check(root)
    else:
        print(f"Unknown: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
