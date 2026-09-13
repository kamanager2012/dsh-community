/**
 * ACS v0.7 — 修复验证测试
 * 覆盖 CRITICAL 修复：_applyPatch, rollback, checkIntegrity, path normalization, RiskLevel
 */
import { describe, it, expect } from "vitest";
import { PatchTransactionSystem } from "../src/patch/transaction.js";
import { PatchClassifier } from "../src/patch/classifier.js";
import { Pipeline } from "../src/runtime/pipeline.js";
import { ScopeEnforcer, DEFAULT_SCOPE } from "../src/constraint/scope-constraint.js";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let ctr = 0;
const tmp = (name: string) => join(tmpdir(), `acs-${ctr++}-${name}`);
const wf = (name: string, content: string) => { const p = tmp(name); writeFileSync(p, content, "utf-8"); return p; };
const rf = (p: string) => readFileSync(p, "utf-8");
const cl = (p: string) => { if (existsSync(p)) unlinkSync(p); };
const dp = (fp: string, hunks: string[]) => `--- a/${fp}\n+++ b/${fp}\n${hunks.join("")}`;

function newTx() { return new PatchTransactionSystem(); }

// ═══════════════════════════ C-3: applyPatch ═══════════════════════════
describe("C-3: _applyPatch works", () => {
  it("adds line", () => {
    const s = newTx();
    const f = wf("add.ts", "line 1\nline 2\n");
    s.validate(s.begin(f, dp(f, ["@@ -1,2 +1,3 @@\n", " line 1\n", " line 2\n", "+line 3\n"])).id);
    s.apply(s.getHistory()[0].id);
    expect(rf(f)).toContain("line 3");
    cl(f);
  });

  it("deletes line", () => {
    const s = newTx();
    const f = wf("del.ts", "keep\nremove\nlast\n");
    s.validate(s.begin(f, dp(f, ["@@ -1,3 +1,2 @@\n", " keep\n", "-remove\n", " last\n"])).id);
    s.apply(s.getHistory()[0].id);
    expect(rf(f)).not.toContain("remove");
    cl(f);
  });

  it("replaces line", () => {
    const s = newTx();
    const f = wf("rep.ts", "const x = 1;\nconst y = 2;\n");
    s.validate(s.begin(f, dp(f, ["@@ -1,2 +1,2 @@\n", " const x = 1;\n", "-const y = 2;\n", "+const z = 3;\n"])).id);
    s.apply(s.getHistory()[0].id);
    const r = rf(f);
    expect(r).toContain("const z = 3");
    expect(r).not.toContain("const y = 2");
    cl(f);
  });

  it("mid-file hunk", () => {
    const s = newTx();
    const f = wf("mid.ts", "// hdr\nconst a = 1;\nconst b = 2;\n// ftr\n");
    s.validate(s.begin(f, dp(f, ["@@ -2,2 +2,1 @@\n", " const a = 1;\n", "-const b = 2;\n"])).id);
    s.apply(s.getHistory()[0].id);
    const r = rf(f);
    expect(r).toContain("// hdr");
    expect(r).not.toContain("const b = 2");
    expect(r).toContain("// ftr");
    cl(f);
  });
});

// ═══════════════════════════ C-5: rollback ═══════════════════════════
describe("C-5: rollback restores", () => {
  it("apply then rollback", () => {
    const s = newTx();
    const orig = "const a = 1;\nconst b = 2;\n";
    const f = wf("rb.ts", orig);
    s.validate(s.begin(f, dp(f, ["@@ -1,2 +1,3 @@\n", " const a = 1;\n", " const b = 2;\n", "+const c = 3;\n"])).id);
    s.apply(s.getHistory()[0].id);
    expect(rf(f)).not.toBe(orig);
    s.rollback(s.getHistory()[0].id);
    expect(rf(f)).toBe(orig);
    cl(f);
  });

  it("rollback without apply is safe", () => {
    const s = newTx();
    const orig = "safe\n";
    const f = wf("safe.ts", orig);
    s.begin(f, dp(f, ["@@ -1,1 +1,2 @@\n", " safe\n", "+extra\n"]));
    s.rollback(s.getHistory()[0].id);
    expect(rf(f)).toBe(orig);
    cl(f);
  });
});

// ═══════════════════════════ C-4: integrity ═══════════════════════════
describe("C-4: checkIntegrity uses pre-write snapshot", () => {
  it("detects class removal", () => {
    const p = new Pipeline();
    p.initTask({ ...DEFAULT_SCOPE, taskId: "ti", allowedFiles: [join(tmpdir(), "acs-")] });
    const f = wf("int.ts", "export class Foo {}\nexport class Bar {}\n");
    p.lockSource(f);
    writeFileSync(f, "export class Foo {}\n", "utf-8");
    const r = p.checkIntegrity(f);
    expect(r.passed).toBe(false);
    expect(r.errors.some((e) => e.includes("class removed"))).toBe(true);
    cl(f);
  });

  it("passes with no export changes", () => {
    const p = new Pipeline();
    p.initTask({ ...DEFAULT_SCOPE, taskId: "tok", allowedFiles: [join(tmpdir(), "acs-")] });
    const c = "export class Foo {}\nexport const BAR = 1;\n";
    const f = wf("ok.ts", c);
    p.lockSource(f);
    writeFileSync(f, c, "utf-8");
    expect(p.checkIntegrity(f).passed).toBe(true);
    cl(f);
  });
});

// ═══════════════════════════ H-2: path norm ═══════════════════════════
describe("H-2: path traversal blocked", () => {
  it("rejects ../", () => {
    const e = new ScopeEnforcer();
    e.setScope({ ...DEFAULT_SCOPE, taskId: "p1", allowedFiles: ["/project/src"] });
    expect(e.checkFile("/project/src/../.claude/settings.json")).toBe(false);
  });

  it("allows nested", () => {
    const e = new ScopeEnforcer();
    e.setScope({ ...DEFAULT_SCOPE, taskId: "p2", allowedFiles: ["/project/src"] });
    expect(e.checkFile("/project/src/components/Foo.ts")).toBe(true);
  });

  it("empty scope blocks all", () => {
    const e = new ScopeEnforcer();
    e.setScope({ ...DEFAULT_SCOPE, taskId: "p3", allowedFiles: [] });
    expect(e.checkFile("/any/file.ts")).toBe(false);
  });
});

// ═══════════════════════════ M-1: RiskLevel ═══════════════════════════
describe("M-1: RiskLevel uppercase", () => {
  it("LOW for simple", () => {
    const r = new PatchClassifier().classify("src/f.ts", ["const x = 1;"], []);
    expect(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).toContain(r.overallRisk);
  });

  it("CRITICAL for export delete", () => {
    const r = new PatchClassifier().classify("src/f.ts", [], ["export class Foo {}"]);
    expect(r.overallRisk).toBe("CRITICAL");
  });
});

// ═══════════════════════════ lifecycle ═══════════════════════════
describe("Transaction lifecycle", () => {
  it("BEGIN→VALIDATE→APPLY→ROLLBACK end-to-end", () => {
    const s = newTx();
    const orig = "const a = 1;\nconst b = 2;\n";
    const f = wf("e2e.ts", orig);
    const patch = dp(f, ["@@ -1,2 +1,2 @@\n", " const a = 1;\n", "-const b = 2;\n", "+const c = 3;\n"]);

    const tx = s.begin(f, patch);
    expect(tx.status).toBe("pending");

    s.validate(tx.id);
    expect(s.getHistory()[0].status).toBe("approved");

    s.apply(tx.id);
    expect(s.getHistory()[0].status).toBe("applied");
    expect(rf(f)).toContain("const c = 3");

    s.rollback(tx.id);
    expect(s.getHistory()[0].status).toBe("rolled-back");
    expect(rf(f)).toBe(orig);

    cl(f);
  });
});
