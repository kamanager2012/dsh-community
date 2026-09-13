import { describe, expect, it } from "vitest";
import {
  normalizePolicy,
  overlayPolicy,
  validatePolicy,
  type CanonicalPolicy,
} from "../../governor/policy.js";

const base: CanonicalPolicy = {
  allowedPaths: ["**/*"],
  deniedPaths: ["**/.env"],
  allowedCommands: ["git", "node"],
  deniedCommands: ["sudo"],
  deniedFileTypes: [".pem"],
  elevatedCommands: ["node"],
  askCommands: ["git push"],
};

describe("canonical policy", () => {
  it("validates the complete vendor-neutral schema", () => {
    const result = validatePolicy(base);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.policy).toEqual(base);
  });

  it("rejects missing or non-string-array semantic fields", () => {
    expect(validatePolicy({ ...base, deniedFileTypes: undefined }).ok).toBe(false);
    expect(validatePolicy({ ...base, allowedCommands: ["git", 1] }).ok).toBe(false);
    expect(validatePolicy(null).ok).toBe(false);
  });

  it("normalizes whitespace and duplicates deterministically", () => {
    const normalized = normalizePolicy({
      ...base,
      allowedCommands: [" git ", "git", "node", ""],
      deniedPaths: [" **/.env ", "**/.env"],
    });
    expect(normalized.allowedCommands).toEqual(["git", "node"]);
    expect(normalized.deniedPaths).toEqual(["**/.env"]);
  });

  it("preserves explicit empty overrides instead of falling back", () => {
    const overlaid = overlayPolicy(base, {
      allowedCommands: [],
      elevatedCommands: [],
      askCommands: [],
    });
    expect(overlaid.allowedCommands).toEqual([]);
    expect(overlaid.elevatedCommands).toEqual([]);
    expect(overlaid.askCommands).toEqual([]);
    expect(overlaid.deniedCommands).toEqual(["sudo"]);
  });
});
