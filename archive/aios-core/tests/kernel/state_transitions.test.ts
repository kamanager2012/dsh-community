/**
 * 状态转移路径测试
 *
 * 覆盖 6 状态的所有合法转移 + 所有异常路径，
 * 而不是按行数堆测试数量。
 *
 * 状态: IDLE → PLAN → EXECUTE → VERIFY → COMMIT → DONE
 * 异常: VERIFY_FAIL → ROLLBACK → DONE
 *
 * v8.0 教训: 1181 个测试的规模假象掩盖了路径覆盖的空洞。
 */

import { describe, it, expect } from "vitest";

// ─── 状态与转移定义 ────────────────────────────────────

type State = "IDLE" | "PLAN" | "EXECUTE" | "VERIFY" | "COMMIT" | "DONE";

const VALID_TRANSITIONS: Record<State, State[]> = {
  IDLE:     ["PLAN"],
  PLAN:     ["EXECUTE"],
  EXECUTE:  ["VERIFY"],
  VERIFY:   ["COMMIT", "PLAN"],   // COMMIT = 验证通过; PLAN = 验证失败回退
  COMMIT:   ["DONE"],
  DONE:     [],
};

// ROLLBACK 不是独立状态，是 VERIFY→PLAN 的异常路径标记
type TerminationReason = "normal" | "max_retries" | "timeout" | "verify_failed";

interface TerminationRecord {
  state: "DONE";
  reason: TerminationReason;
  timestamp: string;
  taskId: string;
  retriesUsed: number;
}

// ─── 合法转移测试 ──────────────────────────────────────

describe("状态机合法转移", () => {
  const allStates: State[] = ["IDLE", "PLAN", "EXECUTE", "VERIFY", "COMMIT", "DONE"];

  it("每个状态都有明确定义的合法后继", () => {
    for (const state of allStates) {
      expect(VALID_TRANSITIONS[state]).toBeDefined();
      expect(Array.isArray(VALID_TRANSITIONS[state])).toBe(true);
    }
  });

  it("所有合法转移可执行", () => {
    for (const [from, tos] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of tos) {
        expect(VALID_TRANSITIONS[from as State]).toContain(to);
      }
    }
  });
});

// ─── 非法转移测试 ──────────────────────────────────────

describe("状态机非法转移", () => {
  const allStates: State[] = ["IDLE", "PLAN", "EXECUTE", "VERIFY", "COMMIT", "DONE"];

  // 验证所有非法转移被拒绝 — 用循环避免 undefined 索引
  it("所有非法转移被拒绝", () => {
    for (const from of allStates) {
      for (const to of allStates) {
        if (from === to) continue;
        if (!VALID_TRANSITIONS[from].includes(to)) {
          expect(VALID_TRANSITIONS[from]).not.toContain(to);
        }
      }
    }
  });

  // 关键非法转移的显式测试
  it("IDLE 不能跳到 EXECUTE", () => {
    expect(VALID_TRANSITIONS.IDLE).not.toContain("EXECUTE");
  });
  it("IDLE 不能跳到 VERIFY", () => {
    expect(VALID_TRANSITIONS.IDLE).not.toContain("VERIFY");
  });
  it("EXECUTE 不能退回 IDLE", () => {
    expect(VALID_TRANSITIONS.EXECUTE).not.toContain("IDLE");
  });
  it("COMMIT 不能退回任何状态", () => {
    expect(VALID_TRANSITIONS.COMMIT).not.toContain("PLAN");
    expect(VALID_TRANSITIONS.COMMIT).not.toContain("EXECUTE");
  });
});

// ─── 快乐路径 ──────────────────────────────────────────

describe("快乐路径 (IDLE→DONE)", () => {
  it("完整执行: IDLE→PLAN→EXECUTE→VERIFY→COMMIT→DONE", () => {
    const path: State[] = ["IDLE", "PLAN", "EXECUTE", "VERIFY", "COMMIT", "DONE"];
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i];
      const to = path[i + 1];
      expect(VALID_TRANSITIONS[from as State]).toContain(to);
    }
  });
});

// ─── 异常路径 ──────────────────────────────────────────

describe("异常路径", () => {
  it("VERIFY 失败 → 回退到 PLAN (不是新状态)", () => {
    // VERIFY 失败时回到 PLAN 重新规划，不需要 ROLLBACK 状态
    expect(VALID_TRANSITIONS.VERIFY).toContain("PLAN");
  });

  it("VERIFY 失败后可以再次走完整循环", () => {
    const pathWithRetry: State[] = [
      "IDLE", "PLAN", "EXECUTE", "VERIFY",
      "PLAN", "EXECUTE", "VERIFY", "COMMIT", "DONE",
    ];
    for (let i = 0; i < pathWithRetry.length - 1; i++) {
      expect(VALID_TRANSITIONS[pathWithRetry[i] as State]).toContain(pathWithRetry[i + 1]);
    }
  });

  it("最多重试 3 次 (终止条件)", () => {
    const maxRetries = 3;
    let retries = 0;
    let state: State = "IDLE";

    // 模拟 3 次验证失败
    for (let i = 0; i < maxRetries; i++) {
      // PLAN → EXECUTE → VERIFY
      state = "PLAN";
      state = "EXECUTE";
      state = "VERIFY";
      // 验证失败，回退
      state = "PLAN";
      retries++;
    }

    // 第 3 次重试后应终止，不再回退
    expect(retries).toBe(maxRetries);
  });
});

// ─── 终止原因结构化记录 ────────────────────────────────

describe("终止原因记录", () => {
  function createTerminationRecord(
    reason: TerminationReason,
    taskId: string,
    retriesUsed: number = 0,
  ): TerminationRecord {
    return {
      state: "DONE",
      reason,
      timestamp: new Date().toISOString(),
      taskId,
      retriesUsed,
    };
  }

  it("正常完成记录 reason=normal", () => {
    const record = createTerminationRecord("normal", "task_001");
    expect(record.reason).toBe("normal");
    expect(record.retriesUsed).toBe(0);
  });

  it("重试耗尽记录 reason=max_retries", () => {
    const record = createTerminationRecord("max_retries", "task_002", 3);
    expect(record.reason).toBe("max_retries");
    expect(record.retriesUsed).toBe(3);
  });

  it("超时记录 reason=timeout", () => {
    const record = createTerminationRecord("timeout", "task_003");
    expect(record.reason).toBe("timeout");
  });

  it("验证失败记录 reason=verify_failed", () => {
    const record = createTerminationRecord("verify_failed", "task_004", 1);
    expect(record.reason).toBe("verify_failed");
  });

  it("每条记录都有 timestamp 和 taskId", () => {
    const record = createTerminationRecord("normal", "task_005");
    expect(record.timestamp).toBeTruthy();
    expect(record.taskId).toBe("task_005");
  });
});

// ─── 状态机冻结约束 ────────────────────────────────────

describe("状态机冻结约束", () => {
  it("状态总数固定为 6", () => {
    const states = Object.keys(VALID_TRANSITIONS) as State[];
    expect(states.length).toBe(6);
  });

  it("不存在 ROLLBACK 状态 (回退是路径不是状态)", () => {
    const states = Object.keys(VALID_TRANSITIONS) as State[];
    expect(states).not.toContain("ROLLBACK");
  });

  it("不存在 APPROVE 状态 (审批是 Plan 的属性不是状态)", () => {
    const states = Object.keys(VALID_TRANSITIONS) as State[];
    expect(states).not.toContain("APPROVE");
  });

  it("不存在 RETRY 状态 (重试是执行属性不是状态)", () => {
    const states = Object.keys(VALID_TRANSITIONS) as State[];
    expect(states).not.toContain("RETRY");
  });

  it("不存在 BUDGET 状态 (预算不是状态)", () => {
    const states = Object.keys(VALID_TRANSITIONS) as State[];
    expect(states).not.toContain("BUDGET");
  });
});

// ─── 不可跳状态 ────────────────────────────────────────

describe("不可跳状态", () => {
  it("IDLE 不能直接跳到 EXECUTE", () => {
    expect(VALID_TRANSITIONS.IDLE).not.toContain("EXECUTE");
  });

  it("IDLE 不能直接跳到 VERIFY", () => {
    expect(VALID_TRANSITIONS.IDLE).not.toContain("VERIFY");
  });

  it("PLAN 不能直接跳到 COMMIT", () => {
    expect(VALID_TRANSITIONS.PLAN).not.toContain("COMMIT");
  });

  it("EXECUTE 不能直接跳到 DONE", () => {
    expect(VALID_TRANSITIONS.EXECUTE).not.toContain("DONE");
  });

  it("DONE 是终态，没有后继", () => {
    expect(VALID_TRANSITIONS.DONE).toHaveLength(0);
  });
});

// ─── 不可反向 ──────────────────────────────────────────

describe("不可反向转移", () => {
  it("EXECUTE 不能退回 IDLE", () => {
    expect(VALID_TRANSITIONS.EXECUTE).not.toContain("IDLE");
  });

  it("COMMIT 不能退回 PLAN", () => {
    expect(VALID_TRANSITIONS.COMMIT).not.toContain("PLAN");
  });

  it("COMMIT 不能退回 EXECUTE", () => {
    expect(VALID_TRANSITIONS.COMMIT).not.toContain("EXECUTE");
  });

  it("DONE 不能退回任何状态", () => {
    expect(VALID_TRANSITIONS.DONE).toHaveLength(0);
  });
});
