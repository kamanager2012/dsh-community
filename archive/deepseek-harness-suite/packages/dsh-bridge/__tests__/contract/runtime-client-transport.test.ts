import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { DshRuntimeClient } from '../../src/runtime/runtime-client.js';
import { DshEventStream } from '../../src/events/event-stream.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: EventEmitter & { end(): void; write(): boolean };
  pid?: number;
  killed: boolean;
  kill(signal?: string): boolean;
}

const harnessState = vi.hoisted(() => ({
  behavior: null as null | ((prompt: string, opts: any) => Promise<any>),
}));

const spawnState = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
}));

vi.mock('@deepseek-ai/dsh-sdk-client', () => ({
  DeepSeekHarness: class {
    constructor(public launchSpec: unknown) {}
    close(): Promise<void> {
      return Promise.resolve();
    }
    run(prompt: string, opts: any): Promise<any> {
      return harnessState.behavior!(prompt, opts);
    }
  },
}));

vi.mock('node:child_process', () => {
  function makeFakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const stdin: any = new EventEmitter();
    stdin.end = () => {};
    stdin.write = () => true;
    child.stdin = stdin;
    child.pid = 4321;
    child.killed = false;
    child.kill = (sig?: string) => {
      child.killed = true;
      queueMicrotask(() => {
        child.emit('exit', null, sig ?? 'SIGTERM');
        child.stdout.emit('close');
        child.stderr.emit('close');
        child.emit('close');
      });
      return true;
    };
    return child;
  }

  return {
    spawn: ((cmd: string, args: string[]) => {
      spawnState.calls.push({ cmd, args: [...args] });
      const child = makeFakeChild();
      // Successful headless run: emit output then a clean close.
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('headless fallback output'));
        child.emit('close', 0, null);
      });
      return child;
    }) as any,
  };
});

function inboxReceiptNotification(sessionId: string) {
  return {
    method: 'session.event',
    params: {
      sessionId,
      event: { type: 'agent/inbox/spliced', data: { inserted: [{ id: 'msg_1' }] } },
    },
  };
}

describe('DshRuntimeClient transport hardening', () => {
  beforeEach(() => {
    spawnState.calls.length = 0;
    harnessState.behavior = null;
  });

  it('falls back to headless CLI with a "--" separator when the SDK fails before enqueue', async () => {
    harnessState.behavior = async () => {
      throw new Error('handshake failed: runtime unreachable');
    };

    const result = await new DshRuntimeClient().executeTurn({
      prompt: '-dash-prefixed prompt must not parse as a flag',
      config: {},
      events: new DshEventStream(),
    });

    expect(result.executionMode).toBe('headless_cli');
    expect(result.content).toBe('headless fallback output');

    expect(spawnState.calls).toHaveLength(1);
    const args = spawnState.calls[0].args;
    const separatorIndex = args.lastIndexOf('--');
    expect(separatorIndex).toBeGreaterThan(0);
    // Everything after '--' is positional: exactly the prompt.
    expect(args.slice(separatorIndex + 1)).toEqual(['-dash-prefixed prompt must not parse as a flag']);
  });

  it('blocks headless replay when failure happens after the enqueue receipt was observed', async () => {
    harnessState.behavior = async (_prompt, opts) => {
      opts.onNotification(inboxReceiptNotification('sess_x'));
      throw new Error('transport died mid-turn');
    };

    const promise = new DshRuntimeClient().executeTurn({
      prompt: 'mutating turn',
      config: {},
      events: new DshEventStream(),
    });

    await expect(promise).rejects.toThrow(/duplicate mutation side-effects/);
    // The fallback spawn must never fire for a post-enqueue failure.
    expect(spawnState.calls).toHaveLength(0);
  });

  it('detaches the abort listener after an SDK turn completes', async () => {
    harnessState.behavior = async () => ({
      finalResponse: 'done',
      sessionId: 'sess_ok',
      events: [],
      notifications: [],
    });

    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const result = await new DshRuntimeClient().executeTurn({
      prompt: 'hello',
      config: {},
      events: new DshEventStream(),
      signal: controller.signal,
    });

    expect(result.content).toBe('done');
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy.mock.calls[0][0]).toBe('abort');
    // Same handler reference that was registered must be removed.
    expect(removeSpy.mock.calls[0][1]).toBe(addSpy.mock.calls[0][1]);
  });

  it('detaches the abort listener after a headless fallback run finishes', async () => {
    harnessState.behavior = async () => {
      throw new Error('boot failed before enqueue');
    };

    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const result = await new DshRuntimeClient().executeTurn({
      prompt: 'plain prompt',
      config: {},
      events: new DshEventStream(),
      signal: controller.signal,
    });

    expect(result.executionMode).toBe('headless_cli');
    expect(spawnState.calls).toHaveLength(1);
    // Both the SDK attempt and the fallback registered a listener; each must
    // have been detached again (balanced), with matching handler references.
    expect(removeSpy.mock.calls.length).toBe(addSpy.mock.calls.length);
    const lastAdd = addSpy.mock.calls.at(-1)!;
    const lastRemove = removeSpy.mock.calls.at(-1)!;
    expect(lastRemove[0]).toBe('abort');
    expect(lastRemove[1]).toBe(lastAdd[1]);
  });
});
