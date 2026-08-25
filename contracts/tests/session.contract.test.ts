import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DshSharedSessionStore } from '../../packages/dsh-bridge/src/session/session-store.js';
import type { DshSession } from '../../packages/dsh-bridge/src/types/index.js';

describe('Shared Session Store Single-Source-of-Truth Contracts', () => {
  let tempOfficialDir: string;
  let tempSuiteDir: string;
  let store: DshSharedSessionStore;

  beforeEach(() => {
    tempOfficialDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-official-sess-'));
    tempSuiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-suite-sess-'));
    store = new DshSharedSessionStore(tempOfficialDir, tempSuiteDir);
  });

  afterEach(() => {
    if (fs.existsSync(tempOfficialDir)) {
      fs.rmSync(tempOfficialDir, { recursive: true, force: true });
    }
    if (fs.existsSync(tempSuiteDir)) {
      fs.rmSync(tempSuiteDir, { recursive: true, force: true });
    }
  });

  it('saves and lists Suite sessions in segregated store without writing to official dir', () => {
    const session: DshSession = {
      id: 'sess_12345',
      title: 'Refactor Auth Pipeline',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspacePath: '/projects/demo',
      model: 'deepseek-reasoner',
      messages: [
        { id: 'm1', role: 'user', content: 'Help me refactor auth', timestamp: Date.now(), status: 'complete' },
        { id: 'm2', role: 'assistant', content: 'Sure, let us analyze...', timestamp: Date.now(), status: 'complete' }
      ],
      metrics: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        tps: 35,
        contextLimit: 128000,
        contextUsagePercent: 0.1,
      },
    };

    store.saveSession(session);

    // Verify official dir is NOT written
    expect(fs.readdirSync(tempOfficialDir)).toHaveLength(0);

    // Verify suite dir has the session
    const summaries = store.listSessions();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe('sess_12345');
    expect(summaries[0].title).toBe('Refactor Auth Pipeline');
    expect(summaries[0].messageCount).toBe(2);

    const loaded = store.readSession('sess_12345');
    expect(loaded).not.toBeNull();
    expect(loaded?.messages).toHaveLength(2);
  });

  it('discovers official JSONL sessions in read-only mode from official project layout', () => {
    const projectDir = path.join(tempOfficialDir, 'proj-alpha', 'sess-001');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'session.jsonl'), '{"event":"init"}\n', 'utf-8');

    const official = store.listOfficialSessions();
    expect(official).toHaveLength(1);
    expect(official[0].id).toBe('sess-001');
    expect(official[0].projectKey).toBe('proj-alpha');

    const allSummaries = store.listSessions();
    expect(allSummaries).toHaveLength(1);
    expect(allSummaries[0].isOfficial).toBe(true);
  });

  it('supports multimodal image payload and sub-agent job persistence (0.1.1-rc.2)', () => {
    const sessionWithMultimodal: DshSession = {
      id: 'sess_multimodal_001',
      title: 'Multimodal UI Review',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspacePath: '/projects/demo-ui',
      model: 'deepseek-reasoner',
      messages: [
        {
          id: 'msg_m1',
          role: 'user',
          content: 'Analyze this UI layout',
          images: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
              name: 'ui_mockup.png',
            }
          ],
          timestamp: Date.now(),
          status: 'complete',
        }
      ],
      metrics: {
        promptTokens: 250,
        completionTokens: 80,
        totalTokens: 330,
        tps: 42,
        contextLimit: 128000,
        contextUsagePercent: 0.25,
      },
      jobs: [
        {
          id: 'job_001',
          name: 'Visual Layout Inspector',
          agentType: 'subagent',
          status: 'done',
          prompt: 'Inspect CSS grid',
          createdAt: Date.now() - 1000,
          updatedAt: Date.now(),
          output: 'Grid alignment verified',
        }
      ]
    };

    store.saveSession(sessionWithMultimodal);

    const loaded = store.readSession('sess_multimodal_001');
    expect(loaded).not.toBeNull();
    expect(loaded?.messages[0].images).toHaveLength(1);
    expect(loaded?.messages[0].images?.[0].name).toBe('ui_mockup.png');
    expect(loaded?.jobs).toHaveLength(1);
    expect(loaded?.jobs?.[0].status).toBe('done');
  });
});
