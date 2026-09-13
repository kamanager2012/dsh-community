// AIOS Core — Verifier (stateless).
//
// Industrial redesign: verifier is a pure function.
// One verification pass per call. No auto-fix loop.
// Auto-fix logic is owned by runtime, not verifier.
//
// Per Charter §3: build + test + lint + e2e; auto-fix is a runtime concern.

import type { EvidenceItem, ExecutionResult, VerificationReport } from "./schema/index.js";

// ── Verifier function signature ────────────────────────────────────────────

export interface VerifierFn {
  (result: ExecutionResult): Promise<VerificationReport>;
}

// ── Adapter: IO operations the verifier needs ──────────────────────────────

export interface VerifierAdapter {
  runBuild: () => Promise<{ ok: boolean; log: string }>;
  runTest: () => Promise<{ ok: boolean; passed: number; failed: number; log: string }>;
  runLint: () => Promise<{ ok: boolean; log: string }>;
  runE2E: () => Promise<{ ok: boolean; log: string }>;
  now: () => string;
  newId: () => string;
}

// ── Factory: create a stateless verifier function ──────────────────────────

export function createVerifier(adapter: VerifierAdapter): VerifierFn {
  return async (result: ExecutionResult): Promise<VerificationReport> => {
    if (result.status !== "succeeded") {
      return {
        planId: adapter.newId(),
        status: "fail",
        testsRun: 0,
        testsPassed: 0,
        testsFailed: 0,
        logSummary: "executor reported failure",
        autoFixAttempts: 0,
        evidence: [
          {
            kind: "diff",
            status: "missing",
            summary: "executor failed before verifiable output was produced",
          },
        ],
      };
    }

    const testResult = await adapter.runTest();
    const build = await adapter.runBuild();
    const lint = await adapter.runLint();
    const e2e = await adapter.runE2E();

    const evidence: EvidenceItem[] = [
      {
        kind: "test",
        status: testResult.ok ? "pass" : "fail",
        summary: testResult.log,
        metrics: {
          passed: testResult.passed,
          failed: testResult.failed,
          total: testResult.passed + testResult.failed,
        },
      },
      {
        kind: "build",
        status: build.ok ? "pass" : "fail",
        summary: build.log,
      },
      {
        kind: "lint",
        status: lint.ok ? "pass" : "fail",
        summary: lint.log,
      },
      {
        kind: "e2e",
        status: e2e.ok ? "pass" : "fail",
        summary: e2e.log,
      },
      {
        kind: "diff",
        status: result.diff.trim().length > 0 ? "pass" : "missing",
        summary: result.diff.trim().length > 0 ? "execution produced a diff" : "execution produced no diff",
      },
    ];

    const allPass = build.ok && testResult.ok && lint.ok && e2e.ok;
    return {
      planId: result.planId,
      status: allPass ? "pass" : "fail",
      testsRun: testResult.passed + testResult.failed,
      testsPassed: testResult.passed,
      testsFailed: testResult.failed,
      logSummary: [build.log, testResult.log, lint.log, e2e.log].join("\n--\n").slice(-2000),
      autoFixAttempts: 0,
      evidence,
    };
  };
}
