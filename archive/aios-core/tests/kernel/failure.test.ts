import { describe, it, expect } from "vitest";
import { classifyFailure, shouldRetry, type FailureInput } from "../../kernel/failure.js";

describe("classifyFailure", () => {
  const base: FailureInput = {
    phase: "EXECUTE",
    taskId: "t1",
    at: "2026-06-14T00:00:00Z",
  };

  it("classifies scope rejection as permission", () => {
    const result = classifyFailure({ ...base, phase: "PLAN", scopeRejected: true });
    expect(result.category).toBe("permission");
    expect(result.recoverable).toBe(false);
    expect(result.maxRetries).toBe(0);
  });

  it("classifies approval denial as permission", () => {
    const result = classifyFailure({ ...base, phase: "PLAN", approvalDenied: true });
    expect(result.category).toBe("permission");
    expect(result.recoverable).toBe(false);
  });

  it("classifies limits exceeded as resource", () => {
    const result = classifyFailure({ ...base, limitsExceeded: true });
    expect(result.category).toBe("resource");
    expect(result.recoverable).toBe(false);
  });

  it("classifies transient errors (ETIMEDOUT)", () => {
    const result = classifyFailure({ ...base, error: "connection ETIMEDOUT after 30s" });
    expect(result.category).toBe("transient");
    expect(result.recoverable).toBe(true);
    expect(result.maxRetries).toBe(3);
  });

  it("classifies transient errors (rate limit)", () => {
    const result = classifyFailure({ ...base, error: "API rate limit exceeded" });
    expect(result.category).toBe("transient");
  });

  it("classifies corruption errors", () => {
    const result = classifyFailure({ ...base, error: "checksum mismatch in staging" });
    expect(result.category).toBe("corruption");
    expect(result.recoverable).toBe(false);
  });

  it("classifies invariant violation as corruption", () => {
    const result = classifyFailure({ ...base, error: "invariant violation: COMMIT_AFTER_VERIFY_PASS" });
    expect(result.category).toBe("corruption");
  });

  it("classifies exec failure as deterministic when not transient", () => {
    const result = classifyFailure({ ...base, execFailed: true, error: "build failed: type error in src/a.ts" });
    expect(result.category).toBe("deterministic");
    expect(result.recoverable).toBe(false);
  });

  it("classifies verify failure as deterministic when not partial", () => {
    const result = classifyFailure({ ...base, verifyFailed: true, error: "0 passed, 5 failed" });
    expect(result.category).toBe("deterministic");
  });

  it("classifies partial success correctly", () => {
    const result = classifyFailure({ ...base, verifyFailed: true, error: "3 passed, 2 failed" });
    expect(result.category).toBe("partial_success");
    expect(result.recoverable).toBe(true);
  });

  it("defaults to unknown for unclassifiable failures", () => {
    const result = classifyFailure({ ...base, error: "something weird happened" });
    expect(result.category).toBe("unknown");
    expect(result.recoverable).toBe(false);
  });
});

describe("shouldRetry", () => {
  it("returns false for non-recoverable failures", () => {
    const failure = classifyFailure({
      phase: "PLAN", scopeRejected: true, taskId: "t1", at: "now",
    });
    expect(shouldRetry(failure, 0)).toBe(false);
  });

  it("returns true for recoverable failures within retry limit", () => {
    const failure = classifyFailure({
      phase: "EXECUTE", error: "ETIMEDOUT", taskId: "t1", at: "now",
    });
    expect(failure.category).toBe("transient");
    expect(shouldRetry(failure, 0)).toBe(true);
    expect(shouldRetry(failure, 2)).toBe(true);
    expect(shouldRetry(failure, 3)).toBe(false); // maxRetries=3
  });

  it("returns false when attempts exhausted", () => {
    const failure = classifyFailure({
      phase: "VERIFY", verifyFailed: true, error: "3 passed, 2 failed", taskId: "t1", at: "now",
    });
    expect(failure.category).toBe("partial_success");
    expect(shouldRetry(failure, 0)).toBe(true);
    expect(shouldRetry(failure, 1)).toBe(false); // maxRetries=1
  });
});
