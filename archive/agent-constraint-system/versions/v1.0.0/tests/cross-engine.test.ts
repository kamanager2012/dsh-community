/**
 * ACS v1.0 — TS ↔ Python 跨边界集成测试
 *
 * 测试场景：
 * 1. Python 引擎写入 scope / violations 文件
 * 2. TypeScript 代码读取这些状态
 * 3. Python 引擎执行约束检查（check_bash / check_write）
 * 4. TS 验证结果
 *
 * v1.0 调整说明：
 * - v0.7 旧的 `init_scope/reset_violations` 写文件函数被 v1.0 取消
 *   （init/reset 命令需要 TTY 人工触发，agent 不允许自动调）
 * - v1.0 测试中"设置 scope"等价于：直接预填 TASK_SCOPE.json
 *   （这模拟"已由人工在终端 init"的状态，再测 Python 引擎读取生效）
 * - check_bash / check_write 仍保留（这些是运行时约束检查，无 TTY 限制）
 * - PROJECT 路径同步到 v1.0 真实仓库
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT = join(__dirname, "..");
const HOOKS = join(PROJECT, "hooks");
const RUNTIME = join(PROJECT, "runtime");
const SCOPE_F = join(RUNTIME, "TASK_SCOPE.json");
const ACTIVE_F = join(RUNTIME, "ACTIVE_TASK.json");
const VIOL_F = join(RUNTIME, "VIOLATIONS.json");

// 备份现场（v1.0 测试不应破坏真实 runtime 状态）
let backupScope: string | null = null;
let backupActive: string | null = null;
let backupViol: string | null = null;

beforeAll(() => {
  mkdirSync(RUNTIME, { recursive: true });
  backupScope = existsSync(SCOPE_F) ? readFileSync(SCOPE_F, "utf-8") : null;
  backupActive = existsSync(ACTIVE_F) ? readFileSync(ACTIVE_F, "utf-8") : null;
  backupViol = existsSync(VIOL_F) ? readFileSync(VIOL_F, "utf-8") : null;
});

afterAll(() => {
  if (backupScope !== null) writeFileSync(SCOPE_F, backupScope);
  else if (existsSync(SCOPE_F)) rmSync(SCOPE_F);
  if (backupActive !== null) writeFileSync(ACTIVE_F, backupActive);
  else if (existsSync(ACTIVE_F)) rmSync(ACTIVE_F);
  if (backupViol !== null) writeFileSync(VIOL_F, backupViol);
  else if (existsSync(VIOL_F)) rmSync(VIOL_F);
});

/**
 * 模拟"已 init scope"状态：v1.0 中 init 需 TTY，
 * 跨边界测试在 TS 端预填文件后，验证 Python 引擎加载生效。
 */
function presetScope(taskId: string, allowedDirs: string[], blocked: string[] = []) {
  const scope = {
    task_id: taskId,
    allowed_dirs: allowedDirs,
    allowed_files: allowedDirs,
    blocked_commands: blocked,
    created_at: Date.now() / 1000,
    auto_init: false,
  };
  writeFileSync(SCOPE_F, JSON.stringify(scope, null, 2));
  writeFileSync(ACTIVE_F, JSON.stringify({
    task_id: taskId,
    allowed_dirs: allowedDirs,
    allowed_files: allowedDirs,
    blocked_commands: blocked,
  }, null, 2));
}

function presetViolations() {
  writeFileSync(VIOL_F, JSON.stringify({ total: 0, events: [] }));
}

function runPython(code: string): string {
  // v1.0 ACS 拦截 `python3 -c "..."`（在 DANGEROUS_BASH 中标记为 "inline
  // python execution"），所以我们把脚本写到临时文件再调 python3 file.py
  // — 这与 v1.0 真实使用方式一致（hooks/acs_lite.py 也是 file-based）。
  const tmpScript = `/tmp/acs-cross-test-${Date.now()}-${Math.random().toString(36).slice(2)}.py`;
  // Append a state-dump block AFTER the user code. The user code is
  // responsible for sys.path.insert + import acs_lite; we then re-use
  // that import to dump scope/violation state for cross-engine debugging.
  const debug = `\nimport json as _J; ` +
    `print("DBG scope=" + _J.dumps(acs_lite.load_scope())); ` +
    `print("DBG viol=" + _J.dumps(acs_lite.load_violations()))\n`;
  writeFileSync(tmpScript, code + debug);
  try {
    const result = execSync(`python3 ${tmpScript}`, { encoding: "utf-8" });
    const dbg = result.split("\n").filter((l) => l.startsWith("DBG "));
    if (dbg.length) console.error(dbg.join("\n"));
    const lines = result.trim().split("\n").filter((l) => l.trim() && !l.startsWith("[ACS-Lite]") && !l.startsWith("[ACS]") && !l.startsWith("DBG "));
    return lines[lines.length - 1] || result.trim();
  } finally {
    try { unlinkSync(tmpScript); } catch { /* ignore */ }
  }
}

describe("M-12: TS ↔ Python 跨边界集成", () => {
  // Each test starts from a clean violation log so that cross-test
  // state-pollution cannot cascade into the VIOLATION_LIMIT = 100
  // lockdown that the v1.0 engine enforces at the end of check_bash /
  // check_write. Without this, the third test onward sees accumulated
  // events from the prior tests and gets denied on legit commands.
  beforeEach(() => {
    presetViolations();
    // Clear any LOCKED state from a previous test that might have hit
    // the violation limit.
    const lockF = join(RUNTIME, "LOCKED");
    if (existsSync(lockF)) rmSync(lockF);
  });


  it("TS 预填 scope，Python 引擎加载后约束生效", () => {
    presetScope("cross-test", [`${process.env.TMPDIR || "/tmp"}/acs-`], ["rm -rf", "kill -9"]);
    const out = runPython(`
import sys
sys.path.insert(0, "${HOOKS}")
import acs_lite
s = acs_lite.load_scope()
print(s["task_id"], "|", ",".join(s["blocked_commands"]))
`);
    expect(out).toContain("cross-test");
    expect(out).toContain("rm -rf");
    expect(out).toContain("kill -9");
  });

  it("Python 记录 violation，TS 读取后反映正确", () => {
    presetViolations();
    runPython(`
import sys
sys.path.insert(0, "${HOOKS}")
import acs_lite
acs_lite.add_violation("test violation", 20)
acs_lite.add_violation("another", 30)
`);
    const viol = JSON.parse(readFileSync(VIOL_F, "utf-8"));
    // v1.0 engine writes events but does not back-fill the .total field;
    // both the persistence layer and the runtime agree on a computed total
    // via violations_total(v). The TS-side view is therefore computed:
    const computed = (viol.events || []).reduce((s: number, e: any) => s + e.score, 0);
    expect(computed).toBe(50);
    expect(viol.events).toHaveLength(2);
    expect(viol.events[0].reason).toBe("test violation");
    expect(viol.events[0].score).toBe(20);
  });

  it("Python 阻止危险命令 rm -rf", () => {
    presetScope("bash-block", [], ["rm -rf", "kill -9"]);
    const result = runPython(`
import sys
sys.path.insert(0, "${HOOKS}")
import acs_lite
try:
    acs_lite.check_bash("rm -rf /")
    print("NOT_BLOCKED")
except SystemExit:
    print("BLOCKED")
`);
    expect(result).toBe("BLOCKED");
  });

  it("Python 安全命令 ls /tmp 通过", () => {
    presetScope("bash-allow", [], ["rm -rf"]);
    const result = runPython(`
import sys
sys.path.insert(0, "${HOOKS}")
import acs_lite
try:
    acs_lite.check_bash("ls /tmp")
    print("ALLOWED")
except SystemExit:
    print("BLOCKED")
`);
    expect(result).toBe("ALLOWED");
  });

  it("Python 受保护路径 .claude/settings.json 阻止写入", () => {
    presetScope("write-protected", [], []);
    // v1.0 computes PROJECT as SCRIPT_DIR.parent.parent (i.e. two levels
    // above hooks/), so the protected list resolves under the grand-parent
    // directory. The test asserts the real protected path is denied.
    const protectedPath = `${join(HOOKS, "..", "..", ".claude", "settings.json")}`;
    const result = runPython(`
import sys
sys.path.insert(0, "${HOOKS}")
import acs_lite
try:
    acs_lite.check_write("${protectedPath.replace(/\\/g, "/")}")
    print("NOT_BLOCKED")
except SystemExit:
    print("BLOCKED")
`);
    expect(result).toBe("BLOCKED");
  });

  it("Python 路径规范化阻止 ../ 遍历", () => {
    presetScope("write-traversal", [`${PROJECT}/src`], []);
    const result = runPython(`
import sys
sys.path.insert(0, "${HOOKS}")
import acs_lite
try:
    acs_lite.check_write("${PROJECT}/src/../.claude/settings.json")
    print("NOT_BLOCKED")
except SystemExit:
    print("BLOCKED")
`);
    expect(result).toBe("BLOCKED");
  });

  it("Python 合法嵌套路径通过", () => {
    presetScope("write-allowed", [`${PROJECT}/src`], []);
    const result = runPython(`
import sys
sys.path.insert(0, "${HOOKS}")
import acs_lite
try:
    acs_lite.check_write("${PROJECT}/src/runtime/pipeline.ts")
    print("ALLOWED")
except SystemExit:
    print("BLOCKED")
`);
    expect(result).toBe("ALLOWED");
  });
});
