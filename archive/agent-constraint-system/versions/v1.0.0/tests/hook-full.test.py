#!/usr/bin/env python3
"""
ACS Python Hook — comprehensive test
Run: python3 tests/hook-full.test.py
"""
import sys, os, json
sys.path.insert(0, "/home/jamesoldman/agent-constraint-system/hooks")
import acs_lite as ACS

RUNTIME = "/home/jamesoldman/agent-constraint-system/runtime"
os.makedirs(RUNTIME, exist_ok=True)

def reset():
    # v1.0 dropped the v0.7 file-writer helpers (init_scope/reset_violations
    # became CLI commands gated behind a TTY check). Cross-test cleanup
    # is now done by writing the runtime files directly, mirroring what
    # the human-init CLI would do for an authorized session.
    scope = {
        "task_id": "test",
        "allowed_dirs": [],
        "allowed_files": [],
        "blocked_commands": [],
        "created_at": 0,
        "auto_init": False,
    }
    with open(os.path.join(RUNTIME, "TASK_SCOPE.json"), "w") as fh:
        json.dump(scope, fh)
    with open(os.path.join(RUNTIME, "ACTIVE_TASK.json"), "w") as fh:
        json.dump({"task_id": "test", "allowed_dirs": [], "allowed_files": [], "blocked_commands": []}, fh)
    with open(os.path.join(RUNTIME, "VIOLATIONS.json"), "w") as fh:
        json.dump({"total": 0, "events": []}, fh)
    # Wipe LOCKED state so subsequent check_bash / check_write can fire.
    lock_f = os.path.join(RUNTIME, "LOCKED")
    if os.path.exists(lock_f):
        os.remove(lock_f)

results = []

def pass_through(label, fn):
    try:
        fn()
        print(f"  ✅ {label}")
        results.append(True)
    except SystemExit:
        print(f"  ❌ {label}: incorrectly blocked")
        results.append(False)

def block(label, fn):
    try:
        fn()
        print(f"  ❌ {label}: not blocked (BUG)")
        results.append(False)
    except SystemExit:
        print(f"  ✅ {label}")
        results.append(True)

print("=== PROTECTED STATE FILES ===")
reset()
block("VIOLATIONS.json",     lambda: ACS.check_write(os.path.join(RUNTIME, "VIOLATIONS.json")))
block("TASK_SCOPE.json",     lambda: ACS.check_write(os.path.join(RUNTIME, "TASK_SCOPE.json")))
block("settings.json",       lambda: ACS.check_write("/home/jamesoldman/agent-constraint-system/.claude/settings.json"))
block("acs_engine.py",       lambda: ACS.check_write("/home/jamesoldman/agent-constraint-system/hooks/acs_engine.py"))
block(".env",                lambda: ACS.check_write("/home/jamesoldman/agent-constraint-system/.env"))
block(".env.production",     lambda: ACS.check_write("/home/jamesoldman/agent-constraint-system/.env.production"))
block(".env.local",         lambda: ACS.check_write("/home/jamesoldman/agent-constraint-system/.env.local"))
block("runtime/*.json any",  lambda: ACS.check_write(os.path.join(RUNTIME, "anything.json")))
block("node_modules/.bin",   lambda: ACS.check_write("/home/jamesoldman/agent-constraint-system/node_modules/.bin/something"))

print("\n=== PATH NORMALIZATION (../ traversal) ===")
reset()
# v1.0 init_scope is CLI+TTY; manually pre-fill scope instead.
with open(os.path.join(RUNTIME, "TASK_SCOPE.json"), "w") as fh:
    json.dump({"task_id": "t", "allowed_dirs": ["/home/jamesoldman/agent-constraint-system/src"], "allowed_files": ["/home/jamesoldman/agent-constraint-system/src"], "blocked_commands": [], "created_at": 0, "auto_init": False}, fh)
with open(os.path.join(RUNTIME, "ACTIVE_TASK.json"), "w") as fh:
    json.dump({"task_id": "t", "allowed_dirs": ["/home/jamesoldman/agent-constraint-system/src"], "allowed_files": ["/home/jamesoldman/agent-constraint-system/src"], "blocked_commands": []}, fh)
block("src/../.claude escaped", lambda: ACS.check_write("/home/jamesoldman/agent-constraint-system/src/../.claude/runtime/TASK_SCOPE.json"))
pass_through("src/runtime/ valid", lambda: ACS.check_write("/home/jamesoldman/agent-constraint-system/src/runtime/pipeline.ts"))
block("new nested file blocked", lambda: ACS.check_write("/home/jamesoldman/agent-constraint-system/src/runtime/components/foo.ts"))

print("\n=== PATH FREEZE (bad filenames) ===")
reset()
block("new_test.ts prefix",  lambda: ACS.check_write("/tmp/new_test.ts"))
block("fixed_ suffix",       lambda: ACS.check_write("/tmp/foo_fixed.ts"))
block("tmp_ suffix",         lambda: ACS.check_write("/tmp/x_tmp.ts"))
block("_v1 suffix",          lambda: ACS.check_write("/tmp/x_v1.ts"))
block("ultimate_test.ts",    lambda: ACS.check_write("/tmp/ultimate_test.ts"))

print("\n=== FILE-WRITE VECTORS (C-1) ===")
reset()
block("python3 -c",          lambda: ACS.check_bash("python3 -c \"print(1)\""))
block("python3 - <<EOF",    lambda: ACS.check_bash("python3 - <<'EOF'\nprint(1)\nEOF"))
block("python -c",           lambda: ACS.check_bash("python -c \"print(1)\""))
block("node -e",             lambda: ACS.check_bash("node -e \"console.log(1)\""))
block("node - <<EOF",        lambda: ACS.check_bash("node - <<'EOF'\nconsole.log(1)\nEOF"))
block("bash -c",             lambda: ACS.check_bash("bash -c \"echo 1\""))
block("sh -c",               lambda: ACS.check_bash("sh -c \"echo 1\""))
block("ruby -e",             lambda: ACS.check_bash("ruby -e \"puts 1\""))
block("perl -e",             lambda: ACS.check_bash("perl -e \"print 1\""))
block("pwsh -c",             lambda: ACS.check_bash("pwsh -c \"echo 1\""))
block("lua -e",              lambda: ACS.check_bash("lua -e \"print(1)\""))
block("> file",             lambda: ACS.check_bash("echo x > /tmp/out"))
block(">> file",            lambda: ACS.check_bash("echo x >> /tmp/out"))
block("2> file",            lambda: ACS.check_bash("cmd 2> /tmp/out"))
block(">&1",                lambda: ACS.check_bash("cmd >&1"))
block("tee /tmp/f",         lambda: ACS.check_bash("echo x | tee /tmp/out"))
block("dd (disk write)",    lambda: ACS.check_bash("dd if=/dev/zero of=/dev/null bs=1 count=1"))
block("dd of=file",         lambda: ACS.check_bash("dd if=/dev/zero of=/tmp/x bs=1"))
block("curl -o",            lambda: ACS.check_bash("curl -o /tmp/f https://x.com"))
block("wget -O",            lambda: ACS.check_bash("wget -O /tmp/f https://x.com"))
block("npm install --prefix", lambda: ACS.check_bash("npm install --prefix /tmp x"))
block("pip install --target",  lambda: ACS.check_bash("pip install --target /tmp x"))

print("\n=== DANGEROUS COMMANDS ===")
reset()
block("rm -rf /",           lambda: ACS.check_bash("rm -rf /"))
block("rm -r -f /",          lambda: ACS.check_bash("rm -r -f /"))
block("rm --no-preserve-root", lambda: ACS.check_bash("rm --no-preserve-root -rf /"))
block("dd of=/dev/sda",      lambda: ACS.check_bash("dd of=/dev/sda if=/dev/zero"))
block("chmod 777 .claude",   lambda: ACS.check_bash("chmod 777 /home/jamesoldman/agent-constraint-system/.claude"))
block("chmod 777 /",         lambda: ACS.check_bash("chmod 777 /"))
block("kill -9",             lambda: ACS.check_bash("kill -9 1"))
block("sed -i",              lambda: ACS.check_bash("sed -i 's/a/b/' f"))
block("sed --in-place",      lambda: ACS.check_bash("sed --in-place 's/a/b/' f"))
block("chattr +i",           lambda: ACS.check_bash("chattr +i f"))
block("chattr -i",           lambda: ACS.check_bash("chattr -i f"))
block("mkfs",                lambda: ACS.check_bash("mkfs.ext4 /dev/sda"))
block("fork bomb",           lambda: ACS.check_bash(":(){ :|:& };:"))
block("fork bomb 2",         lambda: ACS.check_bash(":(){ :|:& };: &"))

print("\n=== SAFE COMMANDS (must NOT block) ===")
reset()
pass_through("ls",            lambda: ACS.check_bash("ls /tmp"))
pass_through("ls -la",        lambda: ACS.check_bash("ls -la /tmp"))
pass_through("cat",           lambda: ACS.check_bash("cat /tmp/file"))
pass_through("head",          lambda: ACS.check_bash("head -5 /tmp/file"))
pass_through("tail",          lambda: ACS.check_bash("tail -5 /tmp/file"))
pass_through("grep",          lambda: ACS.check_bash("grep pattern /tmp/file"))
pass_through("find",          lambda: ACS.check_bash("find /tmp -name '*.ts'"))
pass_through("git status",    lambda: ACS.check_bash("git status"))
pass_through("git diff",      lambda: ACS.check_bash("git diff"))
pass_through("git add .",     lambda: ACS.check_bash("git add ."))
pass_through("git log",       lambda: ACS.check_bash("git log --oneline -5"))
pass_through("npm ls",        lambda: ACS.check_bash("npm ls"))
pass_through("npm run build", lambda: ACS.check_bash("npm run build"))
pass_through("npx vitest run", lambda: ACS.check_bash("npx vitest run"))
pass_through("npx tsc",       lambda: ACS.check_bash("npx tsc --noEmit"))
pass_through("python3 --version", lambda: ACS.check_bash("python3 --version"))
pass_through("node --version", lambda: ACS.check_bash("node --version"))
pass_through("curl https",    lambda: ACS.check_bash("curl https://example.com"))
pass_through("wget -qO- https", lambda: ACS.check_bash("wget -qO- https://example.com"))
pass_through("mkdir",         lambda: ACS.check_bash("mkdir /tmp/acs-test-dir"))
pass_through("touch",         lambda: ACS.check_bash("touch /tmp/acs-test-file"))
pass_through("cp",            lambda: ACS.check_bash("cp /tmp/a /tmp/b"))
pass_through("mv",            lambda: ACS.check_bash("mv /tmp/a /tmp/b"))
pass_through("rm single",      lambda: ACS.check_bash("rm /tmp/single_file"))

print(f"\n{'='*50}")
passed = sum(results)
total = len(results)
print(f"Results: {passed}/{total} passed")
if passed == total:
    print("ALL TESTS PASS ✅")
else:
    print(f"FAIL: {total-passed} test(s) failed")
    sys.exit(1)