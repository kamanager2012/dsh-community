import { describe, expect, it } from "vitest";
import type { EvidenceItem, TaskContract } from "../../kernel/schema/index.js";
import { observeCodexExecEvents } from "../../cli/codex.js";
import {
  assessCodexReliability,
  codexObservationToEvidence,
} from "../../cli/codex_evidence.js";

const usage = {
  input_tokens: 100,
  cached_input_tokens: 20,
  cache_write_input_tokens: 0,
  output_tokens: 30,
  reasoning_output_tokens: 5,
};

function completedRun(extraEvents: unknown[] = []) {
  return observeCodexExecEvents([
    { type: "thread.started", thread_id: "thread-safe" },
    { type: "turn.started" },
    ...extraEvents,
    { type: "turn.completed", usage },
  ]);
}

function contract(requiredEvidence: TaskContract["requiredEvidence"]): TaskContract {
  return { version: 1, requiredEvidence };
}

describe("codexObservationToEvidence", () => {
  it("emits a passing run receipt for a complete terminal run even if one command failed", () => {
    const observation = completedRun([
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "failed once",
          exit_code: 1,
          status: "failed",
        },
      },
      {
        type: "item.completed",
        item: { id: "msg-1", type: "agent_message", text: "Recovered and completed." },
      },
    ]);

    const evidence = codexObservationToEvidence(observation);
    expect(evidence.find((item) => item.id === "codex.run")).toMatchObject({
      kind: "artifact",
      status: "pass",
      source: "codex-exec:thread-safe",
    });
  });

  it("marks a partial stream receipt missing instead of claiming PASS", () => {
    const observation = observeCodexExecEvents([
      { type: "thread.started", thread_id: "thread-partial" },
      { malformed: true },
      { type: "turn.completed", usage },
    ]);

    const evidence = codexObservationToEvidence(observation);
    expect(observation.streamIntegrity).toBe("partial");
    expect(evidence.find((item) => item.id === "codex.run")?.status).toBe("missing");
    expect(evidence.find((item) => item.id === "codex.file_changes")?.status).toBe("missing");
  });

  it("marks a fatal Codex run receipt failed", () => {
    const observation = observeCodexExecEvents([
      { type: "turn.started" },
      { type: "turn.failed", error: { message: "fatal" } },
    ]);

    const evidence = codexObservationToEvidence(observation);
    expect(evidence.find((item) => item.id === "codex.run")?.status).toBe("fail");
  });

  it("requires trustworthy file-change receipts before diff evidence can pass", () => {
    const noDiff = codexObservationToEvidence(completedRun());
    expect(noDiff.find((item) => item.kind === "diff")?.status).toBe("missing");

    const goodDiff = codexObservationToEvidence(completedRun([
      {
        type: "item.completed",
        item: {
          id: "files-1",
          type: "file_change",
          changes: [{ path: "src/example.ts", kind: "update" }],
          status: "completed",
        },
      },
    ]));
    expect(goodDiff.find((item) => item.kind === "diff")?.status).toBe("pass");

    const failedDiff = codexObservationToEvidence(completedRun([
      {
        type: "item.completed",
        item: {
          id: "files-1",
          type: "file_change",
          changes: [{ path: "src/example.ts", kind: "update" }],
          status: "failed",
        },
      },
    ]));
    expect(failedDiff.find((item) => item.kind === "diff")?.status).toBe("fail");
  });

  it("never turns Codex command names into independent test/build evidence", () => {
    const observation = completedRun([
      {
        type: "item.completed",
        item: {
          id: "cmd-test",
          type: "command_execution",
          command: "npm test && npm run build",
          aggregated_output: "all green",
          exit_code: 0,
          status: "completed",
        },
      },
    ]);

    const evidence = codexObservationToEvidence(observation);
    expect(evidence.map((item) => item.kind)).toEqual(["artifact", "diff"]);
    expect(evidence.some((item) => item.kind === "test")).toBe(false);
    expect(evidence.some((item) => item.kind === "build")).toBe(false);
  });
});

describe("assessCodexReliability", () => {
  it("produces INCOMPLETE when a contract requires a diff the run did not produce", () => {
    const assessment = assessCodexReliability({
      taskId: "task-1",
      project: "project-a",
      model: "gpt-5.6-sol",
      version: "codex-test",
      contract: contract(["artifact", "diff"]),
      observation: completedRun(),
    });

    expect(assessment.run.verdict.status).toBe("INCOMPLETE");
    expect(assessment.run.verdict.missingEvidence).toEqual(["diff"]);
  });

  it("produces FAIL for a fatal Codex run", () => {
    const observation = observeCodexExecEvents([
      { type: "turn.failed", error: { message: "fatal" } },
    ]);
    const assessment = assessCodexReliability({
      taskId: "task-fail",
      project: "project-a",
      model: "gpt-5.6-sol",
      version: "codex-test",
      contract: contract(["artifact"]),
      observation,
    });

    expect(assessment.run.verdict.status).toBe("FAIL");
    expect(assessment.run.verdict.failedEvidence).toEqual(["artifact"]);
  });

  it("combines Codex receipts with independent verifier evidence into an existing ReliabilityRun", () => {
    const observation = completedRun([
      {
        type: "item.completed",
        item: {
          id: "files-1",
          type: "file_change",
          changes: [{ path: "src/example.ts", kind: "update" }],
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "cmd-1",
          type: "command_execution",
          command: "npm test",
          aggregated_output: "self-reported pass",
          exit_code: 0,
          status: "completed",
        },
      },
    ]);

    const independentTestEvidence: EvidenceItem = {
      kind: "test",
      id: "aios.verifier.tests",
      status: "pass",
      summary: "independent verifier passed 320 tests",
      source: "aios-verifier",
      metrics: { passed: 320, failed: 0, total: 320 },
    };

    const assessment = assessCodexReliability({
      taskId: "task-pass",
      project: "project-a",
      model: "gpt-5.6-sol",
      version: "codex-test",
      contract: {
        version: 1,
        requiredEvidence: ["artifact", "diff", "test"],
        acceptance: { minTestsPassed: 300 },
      },
      observation,
      additionalEvidence: [independentTestEvidence],
      fingerprint: "abc123",
      interventionCount: 0,
    });

    expect(assessment.run).toMatchObject({
      taskId: "task-pass",
      project: "project-a",
      agent: "codex",
      model: "gpt-5.6-sol",
      version: "codex-test",
      fingerprint: "abc123",
      interventionCount: 0,
    });
    expect(assessment.run.verdict.status).toBe("PASS");
    expect(assessment.evidence.map((item) => item.kind)).toEqual(["artifact", "diff", "test"]);
  });

  it("does not let a successful Codex receipt override failed independent verification", () => {
    const failedTestEvidence: EvidenceItem = {
      kind: "test",
      id: "aios.verifier.tests",
      status: "fail",
      summary: "independent verifier failed",
      source: "aios-verifier",
      metrics: { passed: 319, failed: 1, total: 320 },
    };

    const assessment = assessCodexReliability({
      taskId: "task-independent-fail",
      project: "project-a",
      model: "gpt-5.6-sol",
      version: "codex-test",
      contract: contract(["artifact", "test"]),
      observation: completedRun(),
      additionalEvidence: [failedTestEvidence],
    });

    expect(assessment.run.verdict.status).toBe("FAIL");
    expect(assessment.run.verdict.failedEvidence).toEqual(["test"]);
  });
});
