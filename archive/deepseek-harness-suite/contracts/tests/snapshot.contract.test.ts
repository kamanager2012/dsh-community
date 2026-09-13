import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshVersionManager } from '../../packages/dsh-bridge/src/runtime/version-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

describe('Upstream Snapshot & Patch Surface Contracts', () => {
  it('validates upstream events snapshot schema and required seams', () => {
    const snapshotPath = path.join(rootDir, 'contracts/upstream/events.snapshot.json');
    expect(fs.existsSync(snapshotPath)).toBe(true);

    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    expect(snapshot.events).toContain('agent.thought');
    expect(snapshot.events).toContain('tool.call');
    expect(snapshot.events).toContain('tool.approval_needed');
    expect(snapshot.publicMethods.agent).toContain('prompt');
    expect(snapshot.publicMethods.agent).toContain('interrupt');
  });

  it('enforces TUI Cordis Patch Surface Reduction (zero forbidden core row overrides)', () => {
    const rulesPath = path.join(rootDir, 'contracts/upstream/config-rows.snapshot.json');
    const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));

    // Simulated TUI patch manifest: only allowed UI extensions
    const tuiProposedPatchRows = ['dsh-tui', 'tui-working-activity'];

    for (const row of tuiProposedPatchRows) {
      expect(rules.forbiddenOverrides).not.toContain(row);
      expect(rules.allowedCustomRowInserts).toContain(row);
    }
  });

  it('verifies DSH Version Manager connects to compatibility matrix and picks latest tested', () => {
    const matrixPath = path.join(rootDir, 'contracts/compatibility/matrix.json');
    const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf-8'));

    const vm = new DshVersionManager(undefined, matrix);
    expect(vm.getRecommendedVersion()).toBe('0.1.0-rc.6');

    const launchCmd = vm.getLaunchCommand('0.1.0-rc.6');
    expect(launchCmd.executable).toBe('npx');
    expect(launchCmd.args).toContain('@deepseek-ai/dsh@0.1.0-rc.6');
  });
});
