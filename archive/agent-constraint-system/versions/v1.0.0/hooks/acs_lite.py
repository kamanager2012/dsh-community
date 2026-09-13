#!/usr/bin/env python3
"""
ACS-Lite v1.0 — Agent Constraint System (统一引擎 + 防篡改)

架构:
  PROTECTED(最高优先级) > scope > WRITABLE > out-of-scope(DENY)

  规则维护者: 你 (终端手动操作)
  被约束者:   Claude Code Agent

v1.0: C-2 恢复 + 防篡改 (ACS 自保 Bash 正则 + SHA256 完整性校验)
"""
import json, os, re, sys, time, datetime, hashlib
from pathlib import Path

# ── 路径（基于脚本位置，不依赖 cwd）───────────────────
SCRIPT_DIR = Path(os.path.dirname(os.path.abspath(__file__))).resolve()
# PROJECT 是 hooks/ 目录的父目录 (即仓库根)。
# 之前 v1.0 使用 SCRIPT_DIR.parent.parent 会跳过仓库根、退到
# /home/jamesoldman 这类上层目录，导致 PROTECTED list 与
# .claude/ 路径在错误的位置生效。修正为 SCRIPT_DIR.parent。
PROJECT = SCRIPT_DIR.parent
HOOKS_DIR = SCRIPT_DIR
RUNTIME_DIR = SCRIPT_DIR.parent / "runtime"
TEMPLATE_DIR = SCRIPT_DIR.parent / "templates"
SCOPE_FILE = RUNTIME_DIR / "TASK_SCOPE.json"
VIOLATION_FILE = RUNTIME_DIR / "VIOLATIONS.json"
ACTIVE_TASK_FILE = RUNTIME_DIR / "ACTIVE_TASK.json"
MODE_FILE = RUNTIME_DIR / "MODE.json"
INTEGRITY_FILE = RUNTIME_DIR / "INTEGRITY.json"
LOCK_FILE = RUNTIME_DIR / "LOCKED"
VIOLATION_LIMIT = 100

# ── 受保护路径（agent 绝对不可写）───────────────────
PROTECTED_ABSOLUTE = [
    Path("/etc"),
    Path("/usr"),
    Path("/sbin"),
    Path("/bin"),
    Path("/boot"),
    Path("/root"),
    Path.home() / ".ssh",
    Path.home() / ".gnupg",
]

PROTECTED_PROJECT_RELATIVE = [
    PROJECT / ".claude" / "hooks",
    PROJECT / ".claude" / "settings.json",
    PROJECT / ".claude" / "settings.local.json",
    PROJECT / ".claude" / "runtime",
    PROJECT / ".claude" / "governance",
    PROJECT / ".claude" / "audit",
    # v0.7 兼容：旧 hooks/ 目录 (现位于 hooks/acs_lite.py)
    PROJECT / "hooks" / "acs_lite.py",
    PROJECT / "hooks" / "acs_engine.py",
    PROJECT / "settings.json",
    PROJECT / "settings.local.json",
    PROJECT / "runtime",
    PROJECT / "governance",
    PROJECT / "audit",
]

# v0.7 兼容：通用敏感文件名与后缀（项目无关）
PROTECTED_FILENAME_PATTERNS = [
    r'\.env$',
    r'\.env\.production$',
    r'\.env\.local$',
    r'\.env\.development$',
    r'\.env\.staging$',
    r'\.env\.test$',
    r'\.ssh/',
    r'\.gnupg/',
    r'node_modules/\.bin/',
]

# v0.7 兼容：/tmp 下 “可疑后缀” 文件名（agent 试探保护）
PATH_FREEZE_PATTERNS = [
    r'/tmp/new_[a-zA-Z0-9_]',
    r'_fixed\.[a-z]+$',
    r'_tmp\.[a-z]+$',
    r'_v1\.[a-z]+$',
    r'/tmp/ultimate_test',
]

# ── 允许写入的前缀（优先级低于 PROTECTED）──────────
WRITABLE_PREFIXES = [
    PROJECT,
    Path("/tmp"),
    Path.home() / ".cache",
    Path.home() / ".local" / "share",
]

# ── 危险 Bash 正则 ────────────────────────────────
DANGEROUS_BASH = [
    # ── C-1 文件写入向量 (v0.7 兼容) ──
    (r'\bpython3?\s+-?\s*<<',                            "python inline heredoc"),
    (r'\bnode\s+-e\b',                                   "node inline execution"),
    (r'\bnode\s+-?\s*<<',                                "node inline heredoc"),
    (r'\bruby\s+-e\b',                                   "ruby inline execution"),
    (r'\bperl\s+-e\b',                                   "perl inline execution"),
    (r'\bpwsh\s+-c\b',                                   "pwsh inline execution"),
    (r'\blua\s+-e\b',                                    "lua inline execution"),
    (r'\bbash\s+-c\b',                                   "bash inline execution"),
    (r'\bsh\s+-c\b',                                     "sh inline execution"),
    (r'(?:^|[|;&]\s*)(?:echo|cat|tee|dd)\b.*>\s*/tmp/',  "redirect to /tmp"),
    (r'\btee\s+/tmp/',                                   "tee to /tmp"),
    (r'\bcurl\b.*-o\s+/tmp/',                            "curl download to /tmp"),
    (r'\bwget\b.*-O\s+/tmp/',                            "wget download to /tmp"),
    (r'\bnpm\s+install\s+--prefix\s+/tmp',               "npm install to /tmp"),
    (r'\bpip\s+install\s+--target\s+/tmp',               "pip install to /tmp"),
    (r'\bdd\s+if=/dev/zero\s+of=/tmp/',                  "dd write to /tmp"),

    # ── H-4 追加安全点 (v0.7 兼容) ──
    (r'(?:^|[|;]\s*)rm\s+(?:-[a-zA-Z]+\s+)+/tmp',       "rm with flags on /tmp"),
    (r'(?:^|[|;]\s*)rm\s+-[a-zA-Z]*r[a-zA-Z]*\s+/tmp',   "rm recursive on /tmp"),
    (r'(?:^|[|;]\s*)rm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+/tmp', "rm -rf on /tmp"),
    (r'\bsed\s+--in-place\b',                            "sed --in-place"),
    (r'\bsed\s+-[a-z]*i[a-z]*\b',                        "sed inline edit"),

    # ── 系统破坏 ──
    (r'(?:^|[|;]\s*)rm\s+(?:-[a-zA-Z]+\s+)+/',          "rm with flags on root"),
    (r'(?:^|[|;]\s*)rm\s+-[a-zA-Z]*[rf]\s+/',          "rm -rf on root"),
    (r'(?:^|[|;]\s*)rm\s+-[a-zA-Z]*[rf]\s+\*',         "rm -rf wildcard"),
    (r'(?:^|[|;]\s*)rm\s+-[a-zA-Z]*[rf]\s+~',          "rm -rf on home"),
    (r'(?:^|[|;]\s*)rm\s+-[a-zA-Z]*[rf]\s+\S*PROJ',   "rm -rf on project"),
    (r'\brm\s+--no-preserve-root\b',                    "rm --no-preserve-root"),
    (r'(?:^|[|;]\s*)kill\s+-9\b',                       "kill -9"),
    (r'(?:^|[|;]\s*)mkfs\.',                            "mkfs (disk format)"),
    (r'(?:^|[|;]\s*)dd\s+if=/dev/',                     "dd writing to block device"),
    (r'(?:^|[|;]\s*)dd\s+of=/dev/',                     "dd reading from /dev for write to block device"),
    (r'\bgit\s+push\s+--force',                         "git force push"),
    (r'\bgit\s+reset\s+--hard',                         "git hard reset"),
    (r'\bpython3?\s+-c\s+[\'"]',                        "inline python execution"),
    (r'\beval\b',                                       "eval execution"),
    (r'\bexec\b',                                       "exec execution"),
    (r'\bos\.system\b',                                 "os.system call"),
    (r'>\s*/dev/(?!null)[a-z]',                         "write to device file"),
    (r'\bchmod\s+777',                                  "dangerous permissions"),
    (r'\bchown\s+root',                                 "change owner to root"),
    (r'\breboot\b',                                     "system reboot"),
    (r'\bshutdown\b',                                   "system shutdown"),
    (r'\brmdir\b',                                      "remove directory"),
    (r'\bkillall\b',                                    "kill all processes"),
    (r'\bcat\s+/etc/(shadow|passwd)',                   "read sensitive system file"),
    (r'\bwget\b.*\|\s*sh',                              "wget pipe to shell"),
    (r'\bcurl\b.*\|\s*sh',                              "curl pipe to shell"),
    (r':\(\)\s*\{',                                     "fork bomb"),
    (r'\beval\s+',                                      "dangerous eval"),
    (r'\bsource\s+/dev/',                               "dangerous source"),
    (r'\bpython\b.*\beval\b',                           "python eval"),

    # ── ACS 自保 (v1.0) ──
    (r'(?:cat|tee|dd|cp|mv)\s+.*>\s*\S*acs_lite\.py',  "ACS tamper: overwrite engine"),
    (r'(?:cat|tee|dd)\s+.*>\s*\S*\.claude/hooks/',      "ACS tamper: overwrite hooks dir"),
    (r'(?:cat|tee|dd)\s+.*>\s*\S*\.claude/runtime/',    "ACS tamper: overwrite runtime dir"),
    (r'(?:cat|tee|dd)\s+.*>\s*\S*\.claude/settings\.json', "ACS tamper: overwrite settings"),
    (r'(?:cat|tee|dd)\s+.*>\s*\S*\.claude/governance/', "ACS tamper: overwrite governance"),
    (r'python3?\s+\S*acs_lite\.py\s+reset\b',           "ACS tamper: reset attempt"),
    (r'rm\s+\S*\.claude/(hooks|runtime|governance)',    "ACS tamper: delete ACS files"),
    (r'sed\s+-i.*\.claude/(hooks|runtime|governance)',  "ACS tamper: sed inline on ACS"),
]
COMPILED_BASH = [(re.compile(p, re.I), desc) for p, desc in DANGEROUS_BASH]

# ── 危险批量操作 ──────────────────────────────────
DANGEROUS_GLOB = [
    r'find\s+.*-exec\s+sed\s+-[a-z]*i',
    r'find\s+.*-exec\s+(cp|mv|rm)\b',
    r'find\s+.*\|\s*xargs\s+(sed|cp|mv|rm)\b',
    r'(chmod|chown)\s+-[a-z]*R\s+(/[^a-z]|\.|~/|\.\./)',
]
COMPILED_GLOB = [re.compile(p, re.I) for p in DANGEROUS_GLOB]


# ═══════════════════════════════════════════════════════════
# v1.0 完整性校验系统
# ═══════════════════════════════════════════════════════════

CRITICAL_FILES = [
    HOOKS_DIR / "acs_lite.py",
    HOOKS_DIR / "acs_task.sh",
    SCOPE_FILE,
    ACTIVE_TASK_FILE,
    MODE_FILE,
    VIOLATION_FILE,
    PROJECT / ".claude" / "settings.json",
    PROJECT / ".claude" / "settings.local.json",
]

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

def integrity_snapshot() -> dict:
    snap = {}
    for p in CRITICAL_FILES:
        snap[str(p)] = _sha256(p)
    snap["_timestamp"] = time.time()
    snap["_version"] = "1.0"
    return snap

def integrity_store():
    snap = integrity_snapshot()
    _save(INTEGRITY_FILE, snap)
    return snap

def integrity_verify() -> tuple:
    stored = _load(INTEGRITY_FILE, {})
    if not stored or "_version" not in stored:
        return (False, [], [], ["no baseline — run 'acs_lite.py integrity-store'"])

    current = integrity_snapshot()
    tampered = []
    missing = []
    new_files = []

    for path_str, stored_hash in stored.items():
        if path_str.startswith("_"):
            continue
        cur_hash = current.get(path_str, "MISSING")
        if cur_hash == "MISSING":
            missing.append(path_str)
        elif cur_hash != stored_hash:
            tampered.append(path_str)

    for path_str in current:
        if path_str.startswith("_"):
            continue
        if path_str not in stored:
            new_files.append(path_str)

    ok = len(tampered) == 0 and len(missing) == 0
    return (ok, tampered, missing, new_files)


# ═══════════════════════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════════════════════

def _load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default

def _save(path, data):
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)

def load_scope():
    return _load(SCOPE_FILE, {})

def load_violations():
    return _load(VIOLATION_FILE, {"events": []})

def violations_total(v):
    return sum(e["score"] for e in v.get("events", []))

def save_violations(v):
    _save(VIOLATION_FILE, v)

def add_violation(reason, score):
    v = load_violations()
    v.setdefault("events", []).append({
        "reason": reason,
        "score": score,
        "ts": time.time(),
    })
    save_violations(v)
    total = violations_total(v)
    if total >= VIOLATION_LIMIT:
        LOCK_FILE.write_text("violation limit exceeded: {}\n".format(total))
    return total


# ── ACTIVE_TASK 辅助函数 ──────────────────────────
def _active_task_read() -> dict:
    try:
        if ACTIVE_TASK_FILE.exists():
            return json.loads(ACTIVE_TASK_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        pass
    return {}

def _active_task_write(task_id: str, allowed_dirs: list,
                       allowed_files: list = None,
                       blocked_commands: list = None):
    if allowed_files is None:
        allowed_files = allowed_dirs
    if blocked_commands is None:
        blocked_commands = []
    doc = {
        "version": "1.0",
        "task": task_id,
        "task_id": task_id,
        "status": "ACTIVE",
        "allowed_dirs": allowed_dirs,
        "allowed_files": allowed_files,
        "blocked_commands": blocked_commands,
        "updated_at": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    _save(ACTIVE_TASK_FILE, doc)


# ── 路径判断 ──────────────────────────────────────
def _resolve(path_str):
    p = Path(path_str)
    if not p.is_absolute():
        p = PROJECT / p
    try:
        if p.exists():
            return p.resolve()
        return (PROJECT / path_str).resolve(strict=False)
    except (OSError, RuntimeError):
        return p.absolute()

def _is_protected(resolved):
    for prot in PROTECTED_ABSOLUTE:
        prot_r = prot.resolve() if not prot.is_absolute() else prot
        try:
            resolved.relative_to(prot_r)
            return True
        except ValueError:
            pass
    for prot in PROTECTED_PROJECT_RELATIVE:
        prot_r = prot.resolve() if prot.is_absolute() else (PROJECT / str(prot)).resolve()
        if resolved == prot_r or resolved.is_relative_to(prot_r):
            return True
    # v0.7 兼容：按文件名 / 路径片段匹配
    s = str(resolved)
    for pat in PROTECTED_FILENAME_PATTERNS:
        if re.search(pat, s):
            return True
    # v0.7 兼容：/tmp 下 path freeze（agent 试探保护）
    if str(resolved).startswith("/tmp/") or "/tmp/" in str(resolved):
        for pat in PATH_FREEZE_PATTERNS:
            if re.search(pat, str(resolved)):
                return True
    return False

def _is_writable(resolved):
    for prefix in WRITABLE_PREFIXES:
        prefix_r = prefix.resolve() if not prefix.is_absolute() else prefix
        try:
            resolved.relative_to(prefix_r)
            return True
        except ValueError:
            pass
    return False

def _is_in_scope(resolved, scope):
    allowed_files = scope.get("allowed_files") or []
    allowed_dirs = scope.get("allowed_dirs") or []
    if not allowed_files and not allowed_dirs:
        return True
    # v0.7 语义：allowed_dirs 为 “允许改的目录 prefix”，但禁止在
    # prefix 内部创建 **未在 allowed_files 白名单中出现的新文件**。
    # 也就是说 scope 提供了「在哪些地方改」的范围，却不允许你跳出
    # 现有文件结构生产新文件。
    for a in allowed_files:
        try:
            if resolved == Path(a).resolve():
                return True
        except (OSError, RuntimeError):
            continue
    for d in allowed_dirs:
        try:
            if resolved.is_relative_to(Path(d).resolve()):
                # 路径在 allowed_dir 内，但未在 allowed_files 白名单
                # 中 → 仅在文件已存在时 allow（防止生成新文件）
                if resolved.exists():
                    return True
                return False
        except (OSError, RuntimeError):
            continue
    return False


# ── 拒绝响应 ──────────────────────────────────────
def _deny(reason):
    msg = json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "[ACS-Lite] BLOCKED: {}".format(reason)
        }
    })
    sys.stderr.write(msg + "\n")
    sys.exit(2)


# ── 检查：写文件 ───────────────────────────────────
def check_write(file_path):
    resolved = _resolve(file_path)

    if LOCK_FILE.exists():
        v = load_violations()
        if violations_total(v) < VIOLATION_LIMIT:
            LOCK_FILE.unlink()

    if _is_protected(resolved):
        total = add_violation("protected_path: {}".format(file_path), 50)
        _deny("protected path — {} (violation={})".format(file_path, total))

    if LOCK_FILE.exists():
        total = add_violation("locked_write: {}".format(file_path), 50)
        _deny("system locked — {} (violation={})".format(
            LOCK_FILE.read_text().strip(), total))

    scope = load_scope()
    if not scope.get("task_id"):
        total = add_violation("no_scope_write: {}".format(file_path), 50)
        _deny("no scope initialized (violation={})".format(total))

    if _is_writable(resolved):
        if _is_in_scope(resolved, scope):
            return {"allowed": True, "reason": "writable_and_in_scope"}
        else:
            total = add_violation("out_of_scope: {}".format(file_path), 20)
            _deny("outside scope — {} (violation={})".format(file_path, total))

    total = add_violation("unauthorized_write: {}".format(file_path), 50)
    _deny("unauthorized write target — {} (violation={})".format(file_path, total))


# ── 检查：Bash 命令 ───────────────────────────────
def check_bash(command):
    if LOCK_FILE.exists():
        v = load_violations()
        if violations_total(v) < VIOLATION_LIMIT:
            LOCK_FILE.unlink()

    scope = load_scope()
    if not scope.get("task_id"):
        total = add_violation("no_scope_bash: {}".format(command[:80]), 50)
        _deny("no scope initialized (violation={})".format(total))

    for pattern, desc in COMPILED_BASH:
        if pattern.search(command):
            total = add_violation("blocked_bash: {}".format(desc), 50)
            _deny("{} (violation={})".format(desc, total))

    for pattern in COMPILED_GLOB:
        if pattern.search(command):
            total = add_violation("dangerous_glob: {}".format(command[:80]), 50)
            _deny("dangerous batch operation (violation={})".format(total))

    blocked = scope.get("blocked_commands", [])
    for pattern_str in blocked:
        if re.search(pattern_str, command, re.I):
            total = add_violation("scope_blocked_cmd: {}".format(pattern_str), 30)
            _deny("blocked by scope rule (violation={})".format(total))

    v = load_violations()
    if violations_total(v) >= VIOLATION_LIMIT:
        _deny("violation limit exceeded ({}/{})".format(
            violations_total(v), VIOLATION_LIMIT))

    return {"allowed": True, "reason": "", "violation": violations_total(v)}


# ═══════════════════════════════════════════════════════════
# CLI 命令（仅终端调用，不经过 hook）
# ═══════════════════════════════════════════════════════════

def cmd_init(args):
    if len(args) < 2:
        print("usage: acs_lite.py init <task_id> <dir1,dir2,...> [blocked_cmd_regex,...]")
        sys.exit(1)
    task_id = args[0]
    allowed_dirs = [d.strip() for d in args[1].split(",") if d.strip()]
    blocked = [c.strip() for c in args[2].split(",") if c.strip()] if len(args) > 2 else []

    scope = {
        "task_id": task_id,
        "allowed_dirs": allowed_dirs,
        "allowed_files": allowed_dirs,
        "blocked_commands": blocked,
        "created_at": time.time(),
        "auto_init": False,
    }
    _save(SCOPE_FILE, scope)

    _active_task_write(task_id, allowed_dirs,
                       allowed_files=allowed_dirs,
                       blocked_commands=blocked)

    v = load_violations()
    old_total = violations_total(v)
    v["events"].append({
        "reason": "manual_reset",
        "score": -old_total,
        "ts": time.time(),
        "detail": "scope re-init: {}".format(task_id),
    })
    save_violations(v)

    if LOCK_FILE.exists():
        LOCK_FILE.unlink()

    integrity_store()

    print("[ACS-Lite] scope set: {} ({} dirs)".format(task_id, len(allowed_dirs)))
    print("[ACS-Lite] violations reset: {} -> 0".format(old_total))
    print("[ACS-Lite] lock cleared")
    print("[ACS-Lite] active task saved: {}".format(ACTIVE_TASK_FILE))
    print("[ACS-Lite] integrity snapshot updated: {}".format(INTEGRITY_FILE))


def cmd_status():
    a = _active_task_read()
    s = a if (a.get("task_id") and a["task_id"] != "(none)") else load_scope()

    v = load_violations()
    tid = s.get("task_id", "(none)")
    ts_str = ""
    if s.get("created_at"):
        ts_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(s["created_at"]))
    elif s.get("updated_at"):
        ts_str = s["updated_at"]

    total = violations_total(v)
    locked = LOCK_FILE.exists()

    source = "ACTIVE_TASK.json" if (a.get("task_id") and a["task_id"] != "(none)") else "TASK_SCOPE.json"
    print("[ACS-Lite] task: {}  created: {}  (source: {})".format(tid, ts_str, source))
    print("[ACS-Lite] allowed_dirs: {}".format(s.get('allowed_dirs', s.get('allowed_files', []))))
    print("[ACS-Lite] blocked_cmds: {}".format(s.get('blocked_commands', [])))
    print("[ACS-Lite] violations: {}/{} ({} events)".format(
        total, VIOLATION_LIMIT, len(v.get('events', []))))
    print("[ACS-Lite] locked: {}".format('YES' if locked else 'NO'))
    status = s.get("status", "")
    if status:
        print("[ACS-Lite] status: {}".format(status))
    if s.get("auto_init"):
        print("[ACS-Lite] ZERO-TRUST (auto-init, no scope set)")
    else:
        print("[ACS-Lite] Scope initialized")
    print("[ACS-Lite] C-2: ENFORCED | v1.0: anti-tamper ACTIVE")

    ok, tampered, missing, new = integrity_verify()
    if not ok:
        if tampered:
            print("[ACS-Lite] INTEGRITY FAILURE — {} file(s) modified:".format(len(tampered)))
            for t in tampered:
                print("[ACS-Lite]   TAMPERED: {}".format(t))
        if missing:
            print("[ACS-Lite] INTEGRITY FAILURE — {} file(s) deleted:".format(len(missing)))
            for m in missing:
                print("[ACS-Lite]   MISSING: {}".format(m))
        if new:
            print("[ACS-Lite] NEW FILES: {} — run 'integrity-store' to baseline".format(len(new)))
    else:
        base_time = _load(INTEGRITY_FILE, {}).get("_timestamp", 0)
        base_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(base_time))
        print("[ACS-Lite] INTEGRITY OK (baseline: {})".format(base_str))

    for e in v.get("events", [])[-5:]:
        sign = "+" if e["score"] >= 0 else ""
        print("  {}{:3d}  {}".format(sign, e["score"], e["reason"]))


def cmd_reset(args):
    if "--force" not in args:
        print("[ACS-Lite] ERROR: reset requires --force flag.")
        print("[ACS-Lite]")
        print("[ACS-Lite] C-2 VIOLATION INTEGRITY: violations are non-clearable.")
        print("[ACS-Lite] To reset violations, either:")
        print("[ACS-Lite]   1. acs_lite.py reset --force     (emergency override)")
        print("[ACS-Lite]   2. acs_lite.py init <task> <dirs> (proper scope change)")
        sys.exit(1)

    v = load_violations()
    old_total = violations_total(v)
    v["events"].append({
        "reason": "manual_reset",
        "score": -old_total,
        "ts": time.time(),
        "detail": "manual reset --force from terminal",
    })
    save_violations(v)

    if LOCK_FILE.exists():
        LOCK_FILE.unlink()

    integrity_store()

    print("[ACS-Lite] violations reset: {} -> 0 (events preserved, --force used)".format(old_total))
    print("[ACS-Lite] lock cleared")
    print("[ACS-Lite] integrity snapshot updated")


def cmd_integrity_store():
    snap = integrity_store()
    print("[ACS-Lite] integrity baseline stored: {}".format(INTEGRITY_FILE))
    print("[ACS-Lite] {} critical files hashed".format(len(snap) - 2))
    for p, h in sorted(snap.items()):
        if not p.startswith("_"):
            print("  {}  {}".format(h[:16], p))


def cmd_integrity_check():
    ok, tampered, missing, new = integrity_verify()
    if ok and not new:
        base_time = _load(INTEGRITY_FILE, {}).get("_timestamp", 0)
        base_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(base_time))
        print("[ACS-Lite] INTEGRITY OK — all {} files match baseline ({})".format(
            len(_load(INTEGRITY_FILE, {})) - 2, base_str))
        sys.exit(0)
    else:
        if tampered:
            print("[ACS-Lite] TAMPERED ({} files):".format(len(tampered)))
            for t in tampered:
                print("  MODIFIED: {}".format(t))
        if missing:
            print("[ACS-Lite] MISSING ({} files):".format(len(missing)))
            for m in missing:
                print("  DELETED:  {}".format(m))
        if new:
            print("[ACS-Lite] NEW ({} files) — run 'integrity-store' to baseline:".format(len(new)))
            for n in new:
                print("  NEW:      {}".format(n))
        sys.exit(1)


# ── Hook 入口（由 settings.json 调用）───────────────
def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)

    tool = data.get("tool_name", "")
    inp = data.get("tool_input", {})

    if tool in ("Write", "Edit"):
        fp = inp.get("file_path", "")
        if fp:
            check_write(fp)
    elif tool == "Bash":
        cmd = inp.get("command", "")
        if cmd:
            check_bash(cmd)
    else:
        sys.exit(0)


# ── 入口 ──────────────────────────────────────────
if __name__ == "__main__":
      if len(sys.argv) > 1:
          cmd = sys.argv[1]
          # TTY 门禁：Agent 无终端，不可执行特权命令
          if cmd in ("init", "reset", "integrity-store"):
              if not sys.stdin.isatty():
                  print("[ACS-Lite] DENIED: '{}' 需要终端（TTY）权限。非人工操作被拒绝。".format(cmd), file=sys.stderr)
                  sys.exit(2)
          if cmd == "init":
              cmd_init(sys.argv[2:])
          elif cmd == "status":
              cmd_status()
          elif cmd == "reset":
              cmd_reset(sys.argv[2:])
          elif cmd == "integrity-store":
              cmd_integrity_store()
          elif cmd == "integrity-check":
              cmd_integrity_check()
          else:
              print("usage: acs_lite.py [init|status|reset|integrity-store|integrity-check]", file=sys.stderr)
              sys.exit(1)
      else:
          main()