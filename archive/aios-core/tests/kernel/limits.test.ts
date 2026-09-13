import { describe, it, expect } from "vitest";
import { checkLimits, DEFAULT_LIMITS } from "../../governor/limits.js";

describe("Limits", () => {
  it("allows within limits", () => {
    expect(checkLimits(DEFAULT_LIMITS, { turns: 1, context: 1000, retries: 0 })).toEqual({ ok: true });
  });

  it("rejects when turns exceeded", () => {
    const r = checkLimits(DEFAULT_LIMITS, { turns: 50, context: 0, retries: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("turn");
  });

  it("rejects when context exceeded", () => {
    const r = checkLimits(DEFAULT_LIMITS, { turns: 0, context: 200_000, retries: 0 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("context");
  });

  it("does not reject based on cumulative retries (per-task only)", () => {
    const r = checkLimits(DEFAULT_LIMITS, { turns: 0, context: 0, retries: 100 });
    expect(r.ok).toBe(true);
  });
});
