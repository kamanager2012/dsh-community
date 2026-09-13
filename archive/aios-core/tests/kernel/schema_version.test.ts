import { describe, it, expect } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  stampEntry,
  upgradeEntry,
  validateEntryVersion,
  type VersionedEntry,
} from "../../kernel/schema_version.js";

describe("stampEntry", () => {
  it("adds _v field with current version", () => {
    const entry = stampEntry({ phase: "PLAN", taskId: "t1" });
    expect(entry._v).toBe(CURRENT_SCHEMA_VERSION);
    expect(entry.phase).toBe("PLAN");
  });

  it("overwrites existing _v if present", () => {
    const entry = stampEntry({ _v: 0, phase: "PLAN" });
    expect(entry._v).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe("validateEntryVersion", () => {
  it("accepts current version", () => {
    const result = validateEntryVersion({ _v: CURRENT_SCHEMA_VERSION, x: 1 });
    expect(result.valid).toBe(true);
    expect(result.needsMigration).toBe(false);
  });

  it("flags older version as needing migration", () => {
    const result = validateEntryVersion({ _v: 0, x: 1 });
    expect(result.valid).toBe(true);
    expect(result.needsMigration).toBe(true);
  });

  it("rejects future version", () => {
    const result = validateEntryVersion({ _v: CURRENT_SCHEMA_VERSION + 99, x: 1 });
    expect(result.valid).toBe(false);
  });

  it("treats missing _v as version 0", () => {
    const result = validateEntryVersion({ x: 1 });
    expect(result.version).toBe(0);
    expect(result.needsMigration).toBe(true);
  });
});

describe("upgradeEntry", () => {
  it("upgrades v0 entries to current version", () => {
    const entry: VersionedEntry = { _v: 0, phase: "PLAN" };
    const upgraded = upgradeEntry(entry);
    expect(upgraded._v).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("preserves existing fields during upgrade", () => {
    const entry: VersionedEntry = { _v: 0, phase: "PLAN", taskId: "t1" };
    const upgraded = upgradeEntry(entry);
    expect(upgraded.phase).toBe("PLAN");
    expect(upgraded.taskId).toBe("t1");
  });

  it("leaves current version entries unchanged", () => {
    const entry: VersionedEntry = { _v: CURRENT_SCHEMA_VERSION, phase: "PLAN" };
    const upgraded = upgradeEntry(entry);
    expect(upgraded).toEqual(entry);
  });
});

describe("CURRENT_SCHEMA_VERSION", () => {
  it("is a positive integer", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(CURRENT_SCHEMA_VERSION)).toBe(true);
  });
});
