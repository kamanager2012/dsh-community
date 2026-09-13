/**
 * ACS Agent Freeze
 * =================
 * 连续违规/回滚超限时自动冻结 agent，要求人工接管。
 * 防止 agent 死循环：rollback → 再写坏 → rollback → 再写坏。
 */

export interface FreezeState {
  isFrozen: boolean;
  consecutiveRollbacks: number;
  consecutiveViolations: number;
  maxRollbacks: number;
  maxViolations: number;
  frozenAt: number | null;
  reason: string | null;
}

const MAX_ROLLBACKS = 3;
const MAX_VIOLATIONS = 5;

export class AgentFreeze {
  private state: FreezeState = {
    isFrozen: false,
    consecutiveRollbacks: 0,
    consecutiveViolations: 0,
    maxRollbacks: MAX_ROLLBACKS,
    maxViolations: MAX_VIOLATIONS,
    frozenAt: null,
    reason: null,
  };

  /**
   * 记录一次回滚事件。
   * 超过 maxRollbacks → 冻结 agent。
   */
  recordRollback(): { frozen: boolean; reason: string | null } {
    this.state.consecutiveRollbacks++;
    if (this.state.consecutiveRollbacks >= this.state.maxRollbacks) {
      this._freeze(`连续 ${this.state.maxRollbacks} 次回滚，agent 疑似失控`);
    }
    return { frozen: this.state.isFrozen, reason: this.state.reason };
  }

  /**
   * 记录一次违规事件。
   * 超过 maxViolations → 冻结 agent。
   */
  recordViolation(): { frozen: boolean; reason: string | null } {
    this.state.consecutiveViolations++;
    if (this.state.consecutiveViolations >= this.state.maxViolations) {
      this._freeze(`连续 ${this.state.maxViolations} 次违规，agent 疑似失控`);
    }
    return { frozen: this.state.isFrozen, reason: this.state.reason };
  }

  /**
   * 连续成功操作后逐步衰减违规计数。
   */
  recordSuccess(): void {
    this.state.consecutiveViolations = Math.max(0, this.state.consecutiveViolations - 1);
    this.state.consecutiveRollbacks = Math.max(0, this.state.consecutiveRollbacks - 1);
  }

  /**
   * 人工解冻。
   */
  unfreeze(reason: string): void {
    this.state.isFrozen = false;
    this.state.consecutiveRollbacks = 0;
    this.state.consecutiveViolations = 0;
    this.state.frozenAt = null;
    this.state.reason = null;
    console.log(`[ACS] agent unfrozen: ${reason}`);
  }

  /**
   * 检查 agent 当前是否被冻结。
   */
  isFrozen(): boolean {
    return this.state.isFrozen;
  }

  /**
   * 获取冻结状态。
   */
  getState(): FreezeState {
    return { ...this.state };
  }

  /**
   * 重置。
   */
  reset(): void {
    this.state = {
      isFrozen: false,
      consecutiveRollbacks: 0,
      consecutiveViolations: 0,
      maxRollbacks: MAX_ROLLBACKS,
      maxViolations: MAX_VIOLATIONS,
      frozenAt: null,
      reason: null,
    };
  }

  private _freeze(reason: string): void {
    this.state.isFrozen = true;
    this.state.frozenAt = Date.now();
    this.state.reason = reason;
    console.error(`[ACS] AGENT FROZEN: ${reason}`);
  }
}
