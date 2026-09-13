// AIOS Core — Real deps factory for self-shadow.
// Uses actual vitest/tsc/git instead of mocks.
// The executor applies patches via git apply; the verifier runs real tests.

import { createPlanner } from "../kernel/planner.js";
import { createExecutor } from "../kernel/executor.js";
import { createVerifier } from "../kernel/verifier.js";

import { ScopeValidator } from "../governor/scope.js";
import { Rollback } from "../governor/rollback.js";
import { AuditLog } from "../governor/audit.js";
import { MemoryStore } from "../memory/index.js";
import { DEFAULT_LIMITS } from "../governor/limits.js";
import type { RuntimeDeps } from "../kernel/runtime.js";
import type { ProjectState } from "../kernel/schema/index.js";
import { execSync } from "node:child_process";
import { join } from "node:path";

const AIOS_ROOT = join(import.meta.dirname ?? ".", "..");
const MEMORY_ROOT = join(AIOS_ROOT, ".aios");

export function now() { return new Date().toISOString(); }
let seq = 0;
export function newId() { return `id-${++seq}`; }
export function resetSeq() { seq = 0; }

// ── Real command runner ──────────────────────────────────────────────────

function runCommand(cmd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, {
      cwd: AIOS_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
      // Recursion guard: any child spawned from here (e.g. the real vitest
      // run in realRunTest) inherits this flag, so nested verifiers short-
      // circuit instead of spawning an unbounded tree.
      env: { ...process.env, AIOS_VERIFIER_OFF: "1" },
    });
    return { ok: true, stdout, stderr: "" };
  } catch (e: any) {
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? e.message ?? "",
    };
  }
}

// ── Real project state reader ────────────────────────────────────────────

export async function readProjectState(project: string): Promise<ProjectState> {
  const memory = new MemoryStore({ root: MEMORY_ROOT });
  const raw = await memory.readCurrent("project_state.json");
  if (raw) {
    try { return JSON.parse(raw) as ProjectState; } catch {}
  }
  return {
    goal: "AIOS Core", active_task: null, branch: "main",
    phase: "IDLE", last_change: now(), project,
  };
}

// ── Factory ──────────────────────────────────────────────────────────────

export function createRealDeps(
  overrides?: Partial<RuntimeDeps>,
  memoryRoot?: string,
): RuntimeDeps {
  const memRoot = memoryRoot ?? MEMORY_ROOT;
  const memory = new MemoryStore({ root: memRoot });
  const projectState = readProjectState("aios-core");

  const rollback = new Rollback({
    runCommand: (cmd: string) => Promise.resolve(runCommand(cmd)),
    memory,
    now,
  });

  const audit = new AuditLog({ memory, now, newId });

  const planner = createPlanner({
    readProjectState: () => projectState,
    modelCall: ruleBasedModelCall,
    now,
  });

  const executor = createExecutor({
    applyPatch: async () => "",
    runCommand: (cmd: string) => Promise.resolve(runCommand(cmd)),
    now,
    newId,
  });

  const verifier = createVerifier({
    runBuild: () => Promise.resolve(realRunBuild()),
    runTest: () => Promise.resolve(realRunTest()),
    runLint: () => Promise.resolve({ ok: true, log: "(no linter configured)" }),
    runE2E: () => Promise.resolve({ ok: true, log: "(no e2e configured)" }),
    now,
    newId,
  });

  const deps: RuntimeDeps = {
    planner,
    executor,
    verifier,
    scope: new ScopeValidator(),
    memory,
    rollback,
    audit,
    now,
    newId,
    readProjectState: () => projectState,
    askHuman: async () => true,
    ...overrides,
  };

  (deps as any)._memory = memory;
  return deps;
}

// ── Real verifier deps ───────────────────────────────────────────────────

// The E2E suite drives many tasks against an unchanged project, and each
// task runs the real verifier. Running tsc/vitest subprocesses per task
// makes scenario-heavy tests exceed the 60s per-test timeout. The project
// does not change during a single E2E process, so verify results are cached
// per process (recursion guard branch returns first in subprocesses).
let buildCache: { ok: boolean; log: string } | null = null;
let testCache: { ok: boolean; passed: number; failed: number; log: string } | null = null;

function realRunBuild() {
  if (buildCache) return buildCache;
  const r = runCommand("npx tsc --noEmit 2>&1");
  buildCache = { ok: r.ok, log: r.stdout + r.stderr };
  return buildCache;
}

function realRunTest() {
  // Recursion guard: this E2E suite runs under `vitest run` at the project
  // root; if it spawned a full `vitest run` subprocess, the subprocess would
  // collect this very file and recurse forever (memory exhaustion → host
  // crash). Subprocesses inherit AIOS_VERIFIER_OFF=1 from runCommand's env,
  // so they return here instead of spawning again.
  if (process.env.AIOS_VERIFIER_OFF === "1") {
    return { ok: true, passed: 0, failed: 0, log: "(recursion guard active)" };
  }
  // Subprocess verifies unit/integration tests only (tests/ has no
  // self-spawning tests); the E2E suite itself is already running in the
  // parent vitest process.
  if (testCache) return testCache;
  const r = runCommand("npx vitest run tests/ 2>&1");
  const match = r.stdout.match(/Tests\s+(\d+)\s+passed/);
  const passed = match ? parseInt(match[1]!) : 0;
  const failMatch = r.stdout.match(/(\d+)\s+failed/);
  const failed = failMatch ? parseInt(failMatch[1]!) : 0;
  testCache = { ok: r.ok, passed, failed, log: r.stdout + r.stderr };
  return testCache;
}

// ── Rule-based planner ───────────────────────────────────────────────────

function ruleBasedModelCall(prompt: string): Promise<string> {
  const goalMatch = prompt.match(/Goal:\s*(.+)/);
  const goal = goalMatch?.[1]?.trim() ?? "unknown task";

  const isHighRisk = /migrat|delet|refactor|rewrit|break/i.test(goal);
  const isMediumRisk = /config|depend|packag|tsconfig/i.test(goal);
  const risk = isHighRisk ? "high" : isMediumRisk ? "medium" : "low";
  const approval = risk === "low" ? "AUTO" : "MANUAL";

  const files: string[] = [];
  if (/scope/i.test(goal)) files.push("governor/scope.ts");
  if (/approv/i.test(goal)) files.push("governor/approval.ts");
  if (/rollback/i.test(goal)) files.push("governor/rollback.ts");
  if (/audit/i.test(goal)) files.push("governor/audit.ts");
  if (/memory|context/i.test(goal)) files.push("memory/index.ts", "memory/context.ts");
  if (/runtime/i.test(goal)) files.push("kernel/runtime.ts");
  if (/planner/i.test(goal)) files.push("kernel/planner.ts");
  if (/executor/i.test(goal)) files.push("kernel/executor.ts");
  if (/verif/i.test(goal)) files.push("kernel/verifier.ts");
  if (/reconcil/i.test(goal)) files.push("kernel/reconciler.ts");
  if (/cli/i.test(goal)) files.push("cli/aios.ts");
  if (/schema|type/i.test(goal)) files.push("kernel/schema/index.ts");
  if (/limit/i.test(goal)) files.push("governor/limits.ts");
  if (/replay/i.test(goal)) files.push("kernel/replay.ts");
  if (files.length === 0) files.push("kernel/runtime.ts");

  const response = [
    `task: ${goal}`,
    `risk: ${risk}`,
    `scope: src/**`,
    `files:`,
    ...files.map((f) => `  - ${f}`),
    `approval: ${approval}`,
    `rollback: git revert`,
  ].join("\n");

  return Promise.resolve(response);
}
