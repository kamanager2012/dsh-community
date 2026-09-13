// AIOS Core — Execution Adapter.
//
// Industrial redesign: IO is isolated behind adapters.
// Each ExecutionTier gets a different adapter implementation.
//
// Tier 0: dry-run — no IO, pure simulation
// Tier 1: shadow — real IO, no commit (staging only)
// Tier 2: production — full commit
//
// The adapter provides all IO-bound operations that kernel functions need.
// Kernel functions never touch IO directly — they only call adapter methods.

import type { Plan, ExecutionTier } from "./schema/index.js";
import type { PlannerFn, PlannerAdapter } from "./planner.js";
import type { ExecutorFn, ExecutorAdapter } from "./executor.js";
import type { VerifierFn, VerifierAdapter } from "./verifier.js";
import { createPlanner } from "./planner.js";
import { createExecutor } from "./executor.js";
import { createVerifier } from "./verifier.js";

// ── Unified adapter interface ──────────────────────────────────────────────

export interface RuntimeAdapter {
  tier: ExecutionTier;
  planner: PlannerFn;
  executor: ExecutorFn;
  verifier: VerifierFn;
  runCommand: (cmd: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  now: () => string;
  newId: () => string;
}

// ── Adapter factory ────────────────────────────────────────────────────────

export interface AdapterConfig {
  tier: ExecutionTier;
  now: () => string;
  newId: () => string;
  // Planner IO
  readProjectState: (project: string) => Promise<import("./schema/index.js").ProjectState>;
  modelCall: (prompt: string) => Promise<string>;
  // Executor IO
  applyPatch: (plan: Plan, stagingPath: string) => Promise<string>;
  runCommand: (cmd: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  // Verifier IO
  runBuild: () => Promise<{ ok: boolean; log: string }>;
  runTest: () => Promise<{ ok: boolean; passed: number; failed: number; log: string }>;
  runLint: () => Promise<{ ok: boolean; log: string }>;
  runE2E: () => Promise<{ ok: boolean; log: string }>;
  autoFix?: () => Promise<boolean>;
}

export function createAdapter(config: AdapterConfig): RuntimeAdapter {
  const plannerAdapter: PlannerAdapter = {
    readProjectState: config.readProjectState,
    modelCall: config.modelCall,
    now: config.now,
  };

  const executorAdapter: ExecutorAdapter = {
    applyPatch: config.applyPatch,
    runCommand: config.runCommand,
    now: config.now,
    newId: config.newId,
  };

  const verifierAdapter: VerifierAdapter = {
    runBuild: config.runBuild,
    runTest: config.runTest,
    runLint: config.runLint,
    runE2E: config.runE2E,
    now: config.now,
    newId: config.newId,
  };

  return {
    tier: config.tier,
    planner: createPlanner(plannerAdapter),
    executor: createExecutor(executorAdapter),
    verifier: createVerifier(verifierAdapter),
    runCommand: config.runCommand,
    now: config.now,
    newId: config.newId,
  };
}

// ── Tier 0: Dry-run adapter (pure simulation, no IO) ──────────────────────

export function createDryRunAdapter(overrides?: Partial<AdapterConfig>): RuntimeAdapter {
  return createAdapter({
    tier: 0,
    now: () => new Date().toISOString(),
    newId: (() => { let n = 0; return () => `dry-${++n}`; })(),
    readProjectState: async () => ({
      goal: "", active_task: null, branch: "main", phase: "IDLE", last_change: new Date().toISOString(),
    }),
    modelCall: async () => "task: dry-run\nrisk: low\nscope: src/**\nfiles: []\napproval: AUTO",
    applyPatch: async () => "",
    runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
    runBuild: async () => ({ ok: true, log: "" }),
    runTest: async () => ({ ok: true, passed: 0, failed: 0, log: "" }),
    runLint: async () => ({ ok: true, log: "" }),
    runE2E: async () => ({ ok: true, log: "" }),
    ...overrides,
  });
}

// ── Tier 1: Shadow adapter (real IO, staging only) ────────────────────

export interface ShadowAdapterConfig {
  projectRoot: string;
  now?: () => string;
  newId?: () => string;
  readProjectState?: (project: string) => Promise<import("./schema/index.js").ProjectState>;
  modelCall?: (prompt: string) => Promise<string>;
  applyPatch?: (plan: Plan, stagingPath: string) => Promise<string>;
  runCommand?: (cmd: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  runBuild?: () => Promise<{ ok: boolean; log: string }>;
  runTest?: () => Promise<{ ok: boolean; passed: number; failed: number; log: string }>;
  runLint?: () => Promise<{ ok: boolean; log: string }>;
  runE2E?: () => Promise<{ ok: boolean; log: string }>;
  autoFix?: () => Promise<boolean>;
}

async function _execIn(cmd: string, cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { execSync } = await import("node:child_process");
    const stdout = execSync(cmd, { encoding: "utf8", cwd, timeout: 120_000 });
    return { ok: true, stdout, stderr: "" };
  } catch (e: any) {
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
  }
}

function _parseTestOutput(stdout: string): { passed: number; failed: number } {
  const passMatch = stdout.match(/Tests\s+(\d+)\s+passed/);
  const failMatch = stdout.match(/(\d+)\s+failed/);
  return {
    passed: passMatch ? parseInt(passMatch[1]!, 10) : 0,
    failed: failMatch ? parseInt(failMatch[1]!, 10) : 0,
  };
}

export function createShadowAdapter(config: ShadowAdapterConfig): RuntimeAdapter {
  const root = config.projectRoot;
  const now = config.now ?? (() => new Date().toISOString());
  const newId = config.newId ?? (() => { let n = 0; return () => `shadow-${++n}`; })();

  async function exec(cmd: string) { return _execIn(cmd, root); }

  const adapterCfg: AdapterConfig = {
    tier: 1,
    now,
    newId,
    readProjectState: config.readProjectState ?? (async (project) => {
      try {
        const { readFile } = await import("node:fs/promises");
        const raw = await readFile(`${root}/.aios/current/project_state.json`, "utf8");
        return JSON.parse(raw) as import("./schema/index.js").ProjectState;
      } catch {
        return { goal: "", active_task: null, branch: "main", phase: "IDLE", last_change: now(), project };
      }
    }),
    modelCall: config.modelCall ?? (async () => {
      console.error("[aios] modelCall not configured for shadow tier");
      return "task: shadow\nrisk: low\nscope: src/**\nfiles: []\napproval: AUTO";
    }),
    applyPatch: config.applyPatch ?? (async (plan, stagingPath) => {
      try {
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const safeName = plan.task.replace(/[^a-zA-Z0-9_\-]/g, "_").slice(0, 64);
        const patchDir = join(root, stagingPath, safeName);
        await mkdir(patchDir, { recursive: true });
        await writeFile(join(patchDir, "plan.json"), JSON.stringify(plan, null, 2));
        return `shadow: ${plan.files.length} file(s), ${plan.steps.length} step(s)`;
      } catch {
        return "shadow: (plan saved to staging)";
      }
    }),
    runCommand: config.runCommand ?? exec,
    runBuild: config.runBuild ?? (async () => {
      const r = await exec("npx tsc --noEmit");
      return { ok: r.ok, log: r.stderr || r.stdout || "" };
    }),
    runTest: config.runTest ?? (async () => {
      const r = await exec("npx vitest run 2>&1");
      const counts = _parseTestOutput(r.stdout);
      return {
        ok: r.ok,
        passed: counts.passed,
        failed: counts.failed,
        log: r.stderr || r.stdout || "",
      };
    }),
    runLint: config.runLint ?? (async () => {
      const r = await exec("npx tsc --noEmit");
      return { ok: r.ok, log: r.stderr || r.stdout || "" };
    }),
    runE2E: config.runE2E ?? (async () => {
      const r = await exec("npx vitest run tests/e2e 2>&1");
      return { ok: r.ok, log: r.stderr || r.stdout || "" };
    }),
  };
  if (config.autoFix) adapterCfg.autoFix = config.autoFix;
  return createAdapter(adapterCfg);
}
