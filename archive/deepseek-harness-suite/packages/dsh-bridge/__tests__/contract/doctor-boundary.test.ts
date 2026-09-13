import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const state = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => state.home,
  };
});

import { DshDoctor } from '../../src/runtime/doctor.js';

describe('Doctor official-store read-only boundary', () => {
  let fakeHome = '';

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doctor-home-'));
    state.home = fakeHome;
  });

  afterEach(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('reports a missing official sessions dir without creating it', () => {
    const report = DshDoctor.diagnose({ model: 'deepseek-reasoner', apiKey: 'sk-mock' });
    const storage = report.checks.find(
      (c) => c.category === 'storage' && c.name.includes('Single-Source-of-Truth')
    );

    expect(storage?.status).toBe('pass');
    expect(storage?.detail).toContain('not present yet');

    // Boundary: the official runtime store is never created or written by the suite...
    expect(fs.existsSync(path.join(fakeHome, '.dsh', 'sessions'))).toBe(false);
    // ...while the suite-owned store is provisioned on demand.
    expect(fs.existsSync(path.join(fakeHome, '.dsh', 'suite_sessions'))).toBe(true);
  });

  it('fails the storage check when an existing official store is unreadable', () => {
    // Root ignores permission bits; the assertion would be meaningless.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;

    const sessionsDir = path.join(fakeHome, '.dsh', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.chmodSync(sessionsDir, 0o000);

    try {
      const report = DshDoctor.diagnose({});
      const storage = report.checks.find((c) => c.name.includes('Single-Source-of-Truth'));
      expect(storage?.status).toBe('fail');
      expect(report.overallStatus).toBe('critical');
    } finally {
      fs.chmodSync(sessionsDir, 0o700);
    }
  });
});
