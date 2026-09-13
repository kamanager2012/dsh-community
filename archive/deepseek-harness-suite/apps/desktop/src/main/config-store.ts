import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DshConfig } from '@dsh-community/dsh-bridge';

export class ConfigStore {
  private configPath: string;
  private config: DshConfig;

  constructor(configDir?: string) {
    const dir = configDir || path.join(os.homedir(), '.config', 'dsh-desktop');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.configPath = path.join(dir, 'config.json');
    this.config = this.loadConfig();
  }

  private loadConfig(): DshConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        // Repair permissions of config files written by older versions,
        // regardless of whether their content parses.
        fs.chmodSync(this.configPath, 0o600);
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        const parsed = JSON.parse(raw) as DshConfig;
        return parsed;
      }
    } catch {
      // ignore parse error and fallback
    }

    return {
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: 'deepseek-reasoner',
      port: 3080,
      workspacePath: process.cwd(),
      sandboxMode: 'workspace_only',
    };
  }

  public get(): Readonly<DshConfig> {
    return this.config;
  }

  public save(updates: Partial<DshConfig>): void {
    this.config = { ...this.config, ...updates };
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    // The config contains the API key: restrict to owner-only access.
    fs.chmodSync(this.configPath, 0o600);
  }

  public isFirstRun(): boolean {
    return !this.config.apiKey || this.config.apiKey.trim().length === 0;
  }
}
