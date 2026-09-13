import { describe, it, expect } from 'vitest';
import { runContractDiff, type UpstreamSnapshot } from '../../scripts/contract-checker.js';

function makeSnapshot(overrides: Partial<UpstreamSnapshot> = {}): UpstreamSnapshot {
  return {
    version: '0.1.0-rc.6',
    observedPlugins: [
      '@deepseek-ai/dsh-session-persistence-jsonl',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-llm',
    ],
    cliFlags: {
      web: ['--profile', '--host', '--port', '--trusted-host', '--help'],
      headless: ['--profile', '--help'],
    },
    probeSource: 'live_exec',
    ...overrides,
  };
}

describe('Upstream Contract Checker Fail-Closed Contracts', () => {
  it('passes a healthy live probe with all required plugins and flags present', () => {
    expect(runContractDiff(makeSnapshot())).toBe(true);
  });

  it('still fails on genuine breaking changes detected in a live probe', () => {
    const missingPlugin = runContractDiff(
      makeSnapshot({ observedPlugins: ['@deepseek-ai/dsh-agent'] })
    );
    expect(missingPlugin).toBe(false);

    const lostFlag = runContractDiff(
      makeSnapshot({ cliFlags: { web: ['--help'], headless: ['--help'] } })
    );
    expect(lostFlag).toBe(false);
  });

  it('refuses to PASS invariants derived from the offline fallback snapshot (fail closed)', () => {
    const offline = makeSnapshot({ probeSource: 'offline_snapshot' });
    // Old behavior: fabricated observations sailed through and printed PASSED.
    expect(runContractDiff(offline)).toBe(false);
    expect(runContractDiff(offline, { allowOffline: undefined })).toBe(false);
  });

  it('allows offline snapshot verification only via explicit --allow-offline opt-in', () => {
    const offline = makeSnapshot({
      probeSource: 'offline_snapshot',
      observedPlugins: [
        '@deepseek-ai/dsh-session-persistence-jsonl',
        '@deepseek-ai/dsh-agent',
        '@deepseek-ai/dsh-session',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-approval-core',
        '@deepseek-ai/dsh-sandbox-policy',
      ],
    });

    expect(runContractDiff(offline, { allowOffline: true })).toBe(true);

    // Explicit opt-in must not mask genuine breaking changes.
    expect(
      runContractDiff({ ...offline, observedPlugins: [] }, { allowOffline: true })
    ).toBe(false);
  });
});
