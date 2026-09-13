import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PolicyEvalCase, PolicyEvalSeverity } from "../../kernel/eval.js";

export interface LegacyAcsCase {
  id: string;
  category: string;
  description: string;
  command?: string;
  filepath?: string;
  expected: "block" | "allow";
  severity: PolicyEvalSeverity;
  bypass_methods?: string[];
  note?: string;
  runtime_required?: boolean;
}

interface LegacyFile {
  scenarios: LegacyAcsCase[];
}

export const ACS_V1_ROOT = join(process.cwd(), "shadow", "evals", "policy", "acs-v1");
const RAW = join(ACS_V1_ROOT, "raw");

export const ACS_V1_FILES = [
  "bash_dangerous.json",
  "bypass_attempts.json",
  "false_positive.json",
  "filesystem_write.json",
  "git_destructive.json",
  "self_protect.json",
] as const;

export const ACS_V1_EXPECTED_COUNTS: Record<(typeof ACS_V1_FILES)[number], number> = {
  "bash_dangerous.json": 30,
  "bypass_attempts.json": 20,
  "false_positive.json": 10,
  "filesystem_write.json": 20,
  "git_destructive.json": 15,
  "self_protect.json": 10,
};

export function loadLegacyAcsFile(file: string): LegacyAcsCase[] {
  return (JSON.parse(readFileSync(join(RAW, file), "utf8")) as LegacyFile).scenarios;
}

export function normalizeLegacyAcsCase(item: LegacyAcsCase): PolicyEvalCase {
  const input = item.command
    ? { type: "command" as const, value: item.command }
    : { type: "path" as const, value: item.filepath ?? "" };

  return {
    id: item.id,
    category: item.category,
    description: item.description,
    expected: item.expected === "block" ? "deny" : "allow",
    severity: item.severity,
    input,
    source: {
      repository: "kamanager2012/agent-constraint-system",
      path: `benchmarks/scenarios/${item.category}.json`,
      legacyId: item.id,
    },
    tags: [
      ...(item.runtime_required ? ["runtime-required"] : []),
      ...((item.bypass_methods?.length ?? 0) > 0 ? ["has-bypass-variants"] : []),
    ],
  };
}

export function loadAcsV1Cases(): PolicyEvalCase[] {
  return ACS_V1_FILES
    .flatMap((file) => loadLegacyAcsFile(file))
    .map(normalizeLegacyAcsCase);
}
