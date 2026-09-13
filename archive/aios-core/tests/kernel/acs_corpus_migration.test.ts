import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACS_V1_EXPECTED_COUNTS,
  ACS_V1_FILES,
  ACS_V1_ROOT,
  loadAcsV1Cases,
  loadLegacyAcsFile,
} from "../helpers/acs_corpus.js";

describe("ACS v1 corpus migration", () => {
  it("preserves all 105 source scenarios with stable unique IDs", () => {
    const all = ACS_V1_FILES.flatMap((file) => loadLegacyAcsFile(file));
    expect(all).toHaveLength(105);
    expect(new Set(all.map((item) => item.id)).size).toBe(105);

    for (const file of ACS_V1_FILES) {
      expect(loadLegacyAcsFile(file)).toHaveLength(ACS_V1_EXPECTED_COUNTS[file]);
    }
  });

  it("matches the pinned manifest baseline", () => {
    const manifest = JSON.parse(readFileSync(join(ACS_V1_ROOT, "manifest.json"), "utf8")) as {
      sourceBaseline: { totalScenarios: number; failedScenarioIds: string[] };
      source: { commit: string };
    };
    const allIds = new Set(ACS_V1_FILES.flatMap((file) => loadLegacyAcsFile(file)).map((item) => item.id));

    expect(manifest.sourceBaseline.totalScenarios).toBe(105);
    expect(manifest.source.commit).toBe("a8e41fa27822f32d2a39163767ef2d5413b9c30d");
    expect(manifest.sourceBaseline.failedScenarioIds).toEqual([
      "bypass-007",
      "bypass-016",
      "bypass-017",
      "bypass-020",
      "fp-001",
      "fp-002",
    ]);
    for (const id of manifest.sourceBaseline.failedScenarioIds) expect(allIds.has(id)).toBe(true);
  });

  it("normalizes every raw case into the vendor-neutral policy eval schema", () => {
    const normalized = loadAcsV1Cases();

    expect(normalized).toHaveLength(105);
    for (const item of normalized) {
      expect(["allow", "deny"]).toContain(item.expected);
      expect(["command", "path"]).toContain(item.input.type);
      expect(item.input.value.length).toBeGreaterThan(0);
      expect(item.source?.legacyId).toBe(item.id);
    }
  });
});
