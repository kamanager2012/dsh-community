import type { DshUsageMetrics } from '../types/index.js';

export interface ContextGuardStatus {
  usagePercent: number;
  isWarning: boolean;
  isCritical: boolean;
  recommendation?: 'fork_session' | 'compact_history' | 'normal';
  message?: string;
}

/**
 * Context Overflow Guard & Compaction Advisor
 * 
 * Prevents abrupt conversation failure and model degradation when approaching
 * token context limits, surpassing existing third-party clients that ignore context exhaustion.
 */
export class DshContextGuard {
  private warningThresholdPercent: number;
  private criticalThresholdPercent: number;

  constructor(warningThreshold = 75, criticalThreshold = 90) {
    this.warningThresholdPercent = warningThreshold;
    this.criticalThresholdPercent = criticalThreshold;
  }

  public evaluate(metrics: DshUsageMetrics): ContextGuardStatus {
    const percent = metrics.contextUsagePercent > 0
      ? metrics.contextUsagePercent
      : (metrics.totalTokens / (metrics.contextLimit || 128000)) * 100;

    if (percent >= this.criticalThresholdPercent) {
      return {
        usagePercent: percent,
        isWarning: true,
        isCritical: true,
        recommendation: 'fork_session',
        message: `🚨 Critical: Context window is ${percent.toFixed(1)}% full. Strongly recommended to /fork or /save and start a fresh session to avoid truncation.`,
      };
    }

    if (percent >= this.warningThresholdPercent) {
      return {
        usagePercent: percent,
        isWarning: true,
        isCritical: false,
        recommendation: 'compact_history',
        message: `⚠️ Notice: Context window is ${percent.toFixed(1)}% full. Consider summarizing or branching with /fork.`,
      };
    }

    return {
      usagePercent: percent,
      isWarning: false,
      isCritical: false,
      recommendation: 'normal',
    };
  }
}
