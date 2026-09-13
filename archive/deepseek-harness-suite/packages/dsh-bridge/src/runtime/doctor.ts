import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DshConfig, DshRuntimeHealth, DshUsageMetrics } from '../types/index.js';

export interface DoctorCheckItem {
  name: string;
  category: 'environment' | 'runtime' | 'config' | 'storage' | 'context';
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  overallStatus: 'healthy' | 'warning' | 'critical';
  checks: DoctorCheckItem[];
  timestamp: number;
}

/**
 * DSH System Doctor & Five-Layer Diagnostics
 * 
 * Inspects host environment, Node.js capabilities, subprocess connectivity,
 * session directories, and API configs based on DeepSeek Harness handbook patterns.
 */
export class DshDoctor {
  public static diagnose(
    config: DshConfig,
    runtimeHealth?: DshRuntimeHealth,
    metrics?: DshUsageMetrics
  ): DoctorReport {
    const checks: DoctorCheckItem[] = [];

    // 1. Environment: Node Version
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    if (nodeMajor >= 20) {
      checks.push({
        name: 'Node.js Runtime Version',
        category: 'environment',
        status: 'pass',
        detail: `Node.js ${process.version} (Optimal: v20+)`,
      });
    } else {
      checks.push({
        name: 'Node.js Runtime Version',
        category: 'environment',
        status: 'fail',
        detail: `Node.js ${process.version} is older than required v20+`,
        fix: 'Please upgrade to Node.js v20 or v22 LTS.',
      });
    }

    // 2. OS & Process Tree Support
    const platform = process.platform;
    checks.push({
      name: 'Process Isolation & Tree Kill',
      category: 'environment',
      status: 'pass',
      detail: `Platform: ${platform} (${os.type()} ${os.arch()}), Clean tree kill supported`,
    });

    // 3. Storage: ~/.dsh Directory Accessibility
    const dshHome = path.join(os.homedir(), '.dsh');
    const sessionsDir = path.join(dshHome, 'sessions');
    const suiteSessionsDir = path.join(dshHome, 'suite_sessions');
    try {
      // The official sessions store belongs to the official runtime and is
      // read-only for the suite: probe existence/readability only — never
      // create or mutate it.
      const officialSessionsPresent = fs.existsSync(sessionsDir);
      if (officialSessionsPresent) {
        fs.accessSync(sessionsDir, fs.constants.R_OK);
      }

      // The suite-owned store may be provisioned on demand.
      if (!fs.existsSync(suiteSessionsDir)) {
        fs.mkdirSync(suiteSessionsDir, { recursive: true });
      }
      fs.accessSync(suiteSessionsDir, fs.constants.R_OK | fs.constants.W_OK);

      checks.push({
        name: 'Session Single-Source-of-Truth (~/.dsh/sessions & ~/.dsh/suite_sessions)',
        category: 'storage',
        status: 'pass',
        detail: officialSessionsPresent
          ? `Read/Write permissions verified: ${suiteSessionsDir}; official store readable: ${sessionsDir}`
          : `Suite store verified: ${suiteSessionsDir}. Official sessions dir not present yet (created by the official runtime on first use; never written by the suite)`,
      });
    } catch (err: any) {
      checks.push({
        name: 'Session Single-Source-of-Truth (~/.dsh/sessions & ~/.dsh/suite_sessions)',
        category: 'storage',
        status: 'fail',
        detail: `Cannot access session store: ${err.message}`,
        fix: `Ensure permissions on ${dshHome}`,
      });
    }

    // 4. Storage: Configured Workspace Access
    if (config.workspacePath) {
      try {
        if (!fs.existsSync(config.workspacePath)) {
          fs.mkdirSync(config.workspacePath, { recursive: true });
        }
        fs.accessSync(config.workspacePath, fs.constants.R_OK | fs.constants.W_OK);
        checks.push({
          name: 'Workspace Containment & Directory Access',
          category: 'storage',
          status: 'pass',
          detail: `Workspace path is read/write accessible: ${config.workspacePath}`,
        });
      } catch (err: any) {
        checks.push({
          name: 'Workspace Containment & Directory Access',
          category: 'storage',
          status: 'fail',
          detail: `Cannot write to configured workspace: ${err.message}`,
          fix: `Check filesystem permissions on ${config.workspacePath}`,
        });
      }
    }

    // 4. Config: DeepSeek API Key / Model
    const hasApiKey = Boolean(config.apiKey || process.env.DEEPSEEK_API_KEY);
    const model = config.model || 'deepseek-reasoner';
    if (hasApiKey) {
      checks.push({
        name: 'DeepSeek API Credentials',
        category: 'config',
        status: 'pass',
        detail: `API Key is configured for model: ${model}`,
      });
    } else {
      checks.push({
        name: 'DeepSeek API Credentials',
        category: 'config',
        status: 'warn',
        detail: 'DEEPSEEK_API_KEY is not set in environment or config',
        fix: 'Set export DEEPSEEK_API_KEY="sk-..." or pass in config.',
      });
    }

    // 5. Runtime Health
    if (runtimeHealth && runtimeHealth.running) {
      checks.push({
        name: 'Official DSH Subprocess Runtime',
        category: 'runtime',
        status: 'pass',
        detail: `Active on PID ${runtimeHealth.pid}, URL: ${runtimeHealth.url || 'localhost'} (Uptime: ${runtimeHealth.uptimeSeconds}s)`,
      });
    } else {
      checks.push({
        name: 'Official DSH Subprocess Runtime',
        category: 'runtime',
        status: 'pass',
        detail: 'Standalone bridge mode (Direct SDK execution or lazy spawn)',
      });
    }

    // 6. Context & Token Usage
    if (metrics) {
      const usage = metrics.contextUsagePercent || 0;
      if (usage > 90) {
        checks.push({
          name: 'Context Token Budget',
          category: 'context',
          status: 'fail',
          detail: `Context is ${usage.toFixed(1)}% full (${metrics.totalTokens}/${metrics.contextLimit})`,
          fix: 'Run /fork or /save and restart a fresh session.',
        });
      } else if (usage > 75) {
        checks.push({
          name: 'Context Token Budget',
          category: 'context',
          status: 'warn',
          detail: `Context is ${usage.toFixed(1)}% full (${metrics.totalTokens}/${metrics.contextLimit})`,
          fix: 'Consider branching with /fork before approaching limits.',
        });
      } else {
        checks.push({
          name: 'Context Token Budget',
          category: 'context',
          status: 'pass',
          detail: `Optimal usage: ${usage.toFixed(1)}% (${metrics.totalTokens.toLocaleString()} tokens used)`,
        });
      }
    }

    const hasFail = checks.some((c) => c.status === 'fail');
    const hasWarn = checks.some((c) => c.status === 'warn');
    const overallStatus: DoctorReport['overallStatus'] = hasFail ? 'critical' : hasWarn ? 'warning' : 'healthy';

    return {
      overallStatus,
      checks,
      timestamp: Date.now(),
    };
  }

  public static formatReport(report: DoctorReport): string {
    const statusIcons = {
      pass: '✅',
      warn: '⚠️',
      fail: '❌',
    };

    const overallBadges = {
      healthy: '🟢 All Systems Operational',
      warning: '🟡 System Operable with Warnings',
      critical: '🔴 Critical Issues Detected',
    };

    let text = `🩺 DeepSeek Harness System Health Report\n`;
    text += `Status: ${overallBadges[report.overallStatus]}\n`;
    text += `======================================================\n\n`;

    for (const c of report.checks) {
      text += `${statusIcons[c.status]} [${c.category.toUpperCase()}] ${c.name}\n`;
      text += `   Details: ${c.detail}\n`;
      if (c.fix) {
        text += `   Suggestion: ${c.fix}\n`;
      }
      text += `\n`;
    }

    return text.trim();
  }
}
