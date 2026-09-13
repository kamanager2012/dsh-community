import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { DshConfig, DshRuntimeHealth } from '../types/index.js';
import { DshVersionManager } from './version-manager.js';

export interface SubprocessManagerOptions {
  config: DshConfig;
  customExecutable?: string;
  customArgs?: string[];
  maxLogLines?: number;
}

/**
 * Subprocess Supervisor for Official DeepSeek Harness Runtime.
 * 
 * Manages the lifecycle of `@deepseek-ai/dsh web` or `cli`, keeping the host (Electron/Desktop)
 * completely isolated from the runtime process.
 */
export class DshSubprocessManager {
  private child: ChildProcess | null = null;
  private options: SubprocessManagerOptions;
  private logs: string[] = [];
  private readonly maxLogLines: number;
  private health: DshRuntimeHealth;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(options: SubprocessManagerOptions) {
    this.options = options;
    this.maxLogLines = options.maxLogLines ?? 1000;
    this.health = {
      running: false,
      uptimeSeconds: 0,
    };
  }

  /**
   * Find an available TCP port starting from the desired port
   */
  public async findAvailablePort(startPort: number = 3080): Promise<number> {
    const isPortAvailable = (port: number): Promise<boolean> => {
      return new Promise((resolve) => {
        const server = createServer();
        server.unref();
        server.on('error', () => resolve(false));
        server.listen(port, () => {
          server.close(() => resolve(true));
        });
      });
    };

    let port = startPort;
    while (port < startPort + 50) {
      if (await isPortAvailable(port)) {
        return port;
      }
      port++;
    }
    throw new Error(`Unable to find an open port between ${startPort} and ${startPort + 50}`);
  }

  /**
   * Launch official DSH Web process
   */
  public async start(): Promise<DshRuntimeHealth> {
    if (this.child && !this.child.killed) {
      return this.health;
    }

    const port = this.options.config.port || (await this.findAvailablePort(3080));
    const cwd = this.options.config.workspacePath || process.cwd();

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      DSH_PORT: String(port),
      DEEPSEEK_API_KEY: this.options.config.apiKey || process.env.DEEPSEEK_API_KEY || '',
      DEEPSEEK_BASE_URL: this.options.config.baseUrl || process.env.DEEPSEEK_BASE_URL || '',
    };

    const versionManager = new DshVersionManager();
    const defaultLaunch = versionManager.getLaunchCommand(this.options.config.runtimeVersion);
    const executable = this.options.customExecutable || defaultLaunch.executable;
    const args = this.options.customArgs || [...defaultLaunch.args, '--port', String(port)];

    this.appendLog(`[SUPERVISOR] Spawning: ${executable} ${args.join(' ')} (CWD: ${cwd})`);

    const isPosix = process.platform !== 'win32';
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: isPosix,
    });

    this.child = child;
    const startTime = Date.now();

    this.health = {
      running: true,
      pid: child.pid,
      port,
      url: `http://127.0.0.1:${port}`,
      uptimeSeconds: 0,
      lastHeartbeat: Date.now(),
    };

    child.stdout?.on('data', (data: Buffer) => {
      const line = data.toString();
      this.appendLog(`[STDOUT] ${line.trimEnd()}`);
    });

    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString();
      this.appendLog(`[STDERR] ${line.trimEnd()}`);
    });

    child.on('exit', (code, signal) => {
      this.appendLog(`[SUPERVISOR] Process exited with code ${code}, signal ${signal}`);
      this.health.running = false;
      this.child = null;
      this.stopHealthPolling();
    });

    child.on('error', (err) => {
      this.appendLog(`[SUPERVISOR ERROR] Failed to start process: ${err.message}`);
      this.health.running = false;
      this.child = null;
      // A spawn failure (e.g. ENOENT) emits 'error' without a matching 'exit',
      // so the health poll must be torn down here too or it spins forever.
      this.stopHealthPolling();
    });

    // Start health monitor
    this.startHealthPolling(startTime);

    return this.health;
  }

  private startHealthPolling(startTime: number): void {
    this.stopHealthPolling();

    this.healthCheckTimer = setInterval(() => {
      if (this.child && !this.child.killed) {
        this.health.uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
        this.health.lastHeartbeat = Date.now();
      }
    }, 2000);
  }

  private stopHealthPolling(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Stop the running subprocess gracefully
   */
  public async stop(): Promise<void> {
    this.stopHealthPolling();

    if (!this.child || this.child.killed) {
      this.health.running = false;
      return;
    }

    this.appendLog('[SUPERVISOR] Terminating DSH process tree...');

    const child = this.child;
    const pid = child.pid;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (pid && !child.killed) {
          this.appendLog('[SUPERVISOR] Force killing process tree');
          this.killProcessTree(pid, true);
        }
        this.health.running = false;
        resolve();
      }, 3000);

      child.once('exit', () => {
        clearTimeout(timeout);
        this.health.running = false;
        this.child = null;
        resolve();
      });

      if (pid) {
        this.killProcessTree(pid, false);
      } else {
        child.kill('SIGTERM');
      }
    });
  }

  /**
   * Cross-platform process tree termination to prevent zombie DSH servers on Windows/Linux
   */
  private killProcessTree(pid: number, force = false): void {
    try {
      if (process.platform === 'win32') {
        const flag = force ? '/F' : '';
        spawn('taskkill', ['/PID', String(pid), '/T', flag].filter(Boolean), { stdio: 'ignore' });
      } else {
        const signal = force ? 'SIGKILL' : 'SIGTERM';
        // Try killing the entire process group if negative pid is supported
        try {
          process.kill(-pid, signal);
        } catch {
          process.kill(pid, signal);
        }
      }
    } catch {
      // Ignore if process already died
    }
  }

  /**
   * Restart the runtime subprocess
   */
  public async restart(): Promise<DshRuntimeHealth> {
    await this.stop();
    return this.start();
  }

  public getHealth(): Readonly<DshRuntimeHealth> {
    return this.health;
  }

  public getLogs(): readonly string[] {
    return this.logs;
  }

  private appendLog(message: string): void {
    const timestamp = new Date().toISOString().slice(11, 19);
    this.logs.push(`[${timestamp}] ${message}`);
    if (this.logs.length > this.maxLogLines) {
      this.logs.shift();
    }
  }
}
