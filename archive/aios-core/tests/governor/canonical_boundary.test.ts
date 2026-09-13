import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("canonical policy boundary", () => {
  it("keeps canonical CLI/runtime/scope independent of concrete ACS runtime modules", () => {
    const canonicalFiles = [
      "cli/aios.ts",
      "kernel/runtime.ts",
      "governor/scope.ts",
      "governor/policy.ts",
    ];
    for (const file of canonicalFiles) {
      const text = source(file);
      expect(text, `${file} must not import acs_client`).not.toMatch(/from\s+["'][^"']*acs_client/);
      expect(text, `${file} must not import acs_bridge`).not.toMatch(/from\s+["'][^"']*acs_bridge/);
    }
  });

  it("keeps canonical policy semantics pure and vendor-neutral", () => {
    const text = source("governor/policy.ts");
    expect(text).not.toMatch(/node:fs|child_process|fetch\s*\(|axios/);
    expect(text).not.toMatch(/@anthropic|openai|gemini|claude|codex/i);
  });
});
