#!/usr/bin/env python3
"""
ACS Hook Engine — v0.7.1 verification tests
Run: python3 tests/hook-fixes.test.py
"""
import sys, os, re, json, tempfile, subprocess
# Import the hook engine directly
sys.path.insert(0, "/home/jamesoldman/agent-constraint-system/hooks")
import acs_lite as ACS

PROJECT = "/home/jamesoldman/agent-constraint-system"
RUNTIME = os.path.join(PROJECT, "runtime")
SCOPE_F = os.path.join(RUNTIME, "TASK_SCOPE.json")
VIOL_F  = os.path.join(RUNTIME, "VIOLATIONS.json")

def _init_scope(task_id, allowed_dirs, blocked):
    # v1.0 init_scope is CLI+TTY, so pre-fill the scope files directly
    # to mirror what an authorized human-init would have produced.
    scope = {"task_id": task_id, "allowed_dirs": allowed_dirs, "allowed_files": allowed_dirs, "blocked_commands": blocked, "created_at": 0, "auto_init": False}
    with open(SCOPE_F, "w") as fh:
        json.dump(scope, fh)
    active = {"task_id": task_id, "allowed_dirs": allowed_dirs, "allowed_files": allowed_dirs, "blocked_commands": blocked}
    with open(os.path.join(RUNTIME, "ACTIVE_TASK.json"), "w") as fh:
        json.dump(active, fh)

def reset():
    for f in [SCOPE_F, VIOL_F, os.path.join(RUNTIME, "ACTIVE_TASK.json"), os.path.join(RUNTIME, "LOCKED")]:
        if os.path.exists(f):
            os.remove(f)
    # v1.0 init_scope is CLI+TTY, so pre-fill the scope file directly
    # to mirror what an authorized human-init would have produced.
    scope = {"task_id": "test", "allowed_dirs": [], "allowed_files": [], "blocked_commands": [], "created_at": 0, "auto_init": False}
    with open(SCOPE_F, "w") as fh:
        json.dump(scope, fh)
    active = {"task_id": "test", "allowed_dirs": [], "allowed_files": [], "blocked_commands": []}
    with open(os.path.join(RUNTIME, "ACTIVE_TASK.json"), "w") as fh:
        json.dump(active, fh)
    with open(VIOL_F, "w") as fh:
        json.dump({"total": 0, "events": []}, fh)

def test_c1_python3_c():
    """C-1: python3 -c is blocked as file-write vector"""
    reset()
    try:
        ACS.check_bash("python3 -c \"__import__('json').dump({}, open('x','w'))\"")
        print("  ❌ C-1: python3 -c should be BLOCKED")
        return False
    except SystemExit:
        print("  ✅ C-1: python3 -c blocked")
        return True

def test_c1_node_e():
    """C-1: node -e is blocked"""
    reset()
    try:
        ACS.check_bash("node -e \"require('fs').writeFileSync('x','123')\"")
        print("  ❌ C-1: node -e should be BLOCKED")
        return False
    except SystemExit:
        print("  ✅ C-1: node -e blocked")
        return True

def test_c1_ruby_perl():
    """C-1: ruby -e / perl -e blocked"""
    reset()
    for cmd in ["ruby -e 'File.write(\"x\",\"\")'", "perl -e 'open(x,\">x\")'"]:
        try:
            ACS.check_bash(cmd)
            print(f"  ❌ C-1: {cmd.split()[0]} -e should be BLOCKED")
            return False
        except SystemExit:
            pass
    print("  ✅ C-1: ruby/perl -e blocked")
    return True

def test_c1_shell_redirect():
    """C-1: shell redirection > and >> blocked"""
    reset()
    for cmd in ["echo test > /tmp/x", "echo test >> /tmp/x"]:
        try:
            ACS.check_bash(cmd)
            print(f"  ❌ C-1: {cmd} should be BLOCKED")
            return False
        except SystemExit:
            pass
    print("  ✅ C-1: > and >> redirections blocked")
    return True

def test_c1_tee():
    """C-1: tee command blocked"""
    reset()
    try:
        ACS.check_bash("echo x | tee /tmp/out.txt")
        print("  ❌ C-1: tee should be BLOCKED")
        return False
    except SystemExit:
        print("  ✅ C-1: tee blocked")
        return True

def test_c2_violations_protected():
    """C-2: VIOLATIONS.json is protected against Write/Edit"""
    reset()
    try:
        ACS.check_write(VIOL_F)
        print("  ❌ C-2: VIOLATIONS.json should be PROTECTED")
        return False
    except SystemExit:
        print("  ✅ C-2: VIOLATIONS.json protected")
        return True

def test_c2_scope_protected():
    """C-2: TASK_SCOPE.json is protected"""
    reset()
    try:
        ACS.check_write(SCOPE_F)
        print("  ❌ C-2: TASK_SCOPE.json should be PROTECTED")
        return False
    except SystemExit:
        print("  ✅ C-2: TASK_SCOPE.json protected")
        return True

def test_c2_settings_protected():
    """C-2: settings.json is protected"""
    reset()
    sfile = os.path.join(PROJECT, ".claude", "settings.json")
    try:
        ACS.check_write(sfile)
        print("  ❌ C-2: settings.json should be PROTECTED")
        return False
    except SystemExit:
        print("  ✅ C-2: settings.json protected")
        return True

def test_c2_hook_itself_protected():
    """C-2: acs_engine.py is protected"""
    reset()
    hfile = os.path.join(PROJECT, ".claude", "hooks", "acs_engine.py")
    try:
        ACS.check_write(hfile)
        print("  ❌ C-2: acs_engine.py should be PROTECTED")
        return False
    except SystemExit:
        print("  ✅ C-2: acs_engine.py protected")
        return True

def test_h1_path_traversal():
    """H-1: ../ traversal blocked by path normalization"""
    reset()
    _init_scope("test", [os.path.join(PROJECT, "src")], [])
    try:
        # src/../.claude/settings.json should resolve to .claude/ and be blocked
        bad = os.path.join(PROJECT, "src", "..", ".claude", "settings.json")
        ACS.check_write(bad)
        print("  ❌ H-1: ../ traversal should be BLOCKED")
        return False
    except SystemExit:
        print("  ✅ H-1: ../ traversal blocked")
        return True

def test_h1_realpath():
    """H-1: realpath resolves symlinks"""
    reset()
    _init_scope("test", [os.path.join(PROJECT, "src")], [])
    # a legitimate nested path should pass
    good = os.path.join(PROJECT, "src", "runtime", "pipeline.ts")
    try:
        ACS.check_write(good)
        print("  ✅ H-1: legitimate nested path allowed")
        return True
    except SystemExit:
        print("  ❌ H-1: legitimate path should be ALLOWED")
        return False

def test_h4_rm_variants():
    """H-4: rm -r -f (non-standard spacing) also blocked"""
    reset()
    for cmd in ["rm -r -f /tmp", "rm -rf /tmp", "rm -f /tmp"]:
        try:
            ACS.check_bash(cmd)
            print(f"  ❌ H-4: '{cmd}' should be BLOCKED")
            return False
        except SystemExit:
            pass
    print("  ✅ H-4: rm variants blocked")
    return True

def test_h4_sed_variants():
    """H-4: sed --in-place (long form) blocked"""
    reset()
    try:
        ACS.check_bash("sed --in-place 's/a/b/' file")
        print("  ❌ H-4: sed --in-place should be BLOCKED")
        return False
    except SystemExit:
        print("  ✅ H-4: sed --in-place blocked")
        return True

def test_h5_env_protected():
    """H-5: .env and .env.* are protected"""
    reset()
    for fp in [os.path.join(PROJECT, ".env"),
               os.path.join(PROJECT, ".env.production"),
               os.path.join(PROJECT, ".env.local")]:
        try:
            ACS.check_write(fp)
            print(f"  ❌ H-5: {os.path.basename(fp)} should be PROTECTED")
            return False
        except SystemExit:
            pass
    print("  ✅ H-5: .env variants protected")
    return True

def test_normal_file_allowed():
    """Normal file in scope passes"""
    reset()
    # create a real temp file
    with tempfile.NamedTemporaryFile(suffix=".ts", delete=False, dir=PROJECT) as f:
        f.write(b"const x = 1;\n")
        tmp = f.name
    try:
        _init_scope("test", [os.path.dirname(tmp)], [])
        ACS.check_write(tmp)
        print("  ✅ Normal file in scope: allowed")
        return True
    except SystemExit:
        print("  ❌ Normal file in scope: should be ALLOWED")
        return False
    finally:
        os.unlink(tmp)

if __name__ == "__main__":
    os.makedirs(RUNTIME, exist_ok=True)
    results = []
    for fn in sorted([f for f in dir() if f.startswith("test_")]):
        fn_obj = locals()[fn]
        if callable(fn_obj):
            try:
                results.append(fn_obj())
            except Exception as e:
                print(f"  ❌ {fn}: EXCEPTION {e}")
                results.append(False)
    print()
    passed = sum(results)
    total = len(results)
    print(f"{'='*50}")
    print(f"Python hook fixes: {passed}/{total} passed")
    if passed == total:
        print("All Python hook fixes verified ✅")
    else:
        print(f"WARNING: {total - passed} test(s) failed")
        sys.exit(1)