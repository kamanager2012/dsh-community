import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';


export interface VersionInfo {
  version: string;
  isInstalled: boolean;
  isRecommended: boolean;
  status: 'recommended' | 'supported' | 'deprecated' | 'unknown';
  notes?: string;
}

export interface CompatibilityMatrix {
  latestTestedVersion: string;
  versions: Record<string, {
    status: 'recommended' | 'supported' | 'deprecated';
    tuiCompatible: boolean;
    desktopCompatible: boolean;
    notes?: string;
  }>;
}

/**
 * DSH Runtime Version Manager
 * 
 * Manages side-by-side versions of official @deepseek-ai/dsh runtimes,
 * allowing users to pin versions per-project or use the recommended verified version.
 */
export class DshVersionManager {
  private runtimeBaseDir: string;
  private matrix: CompatibilityMatrix;

  constructor(customRuntimeDir?: string, customMatrix?: CompatibilityMatrix) {
    this.runtimeBaseDir = customRuntimeDir || path.join(os.homedir(), '.config', 'dsh-desktop', 'runtimes');
    if (!fs.existsSync(this.runtimeBaseDir)) {
      fs.mkdirSync(this.runtimeBaseDir, { recursive: true });
    }

    this.matrix = customMatrix || this.loadDefaultMatrix();
  }

  private loadDefaultMatrix(): CompatibilityMatrix {
    return {
      latestTestedVersion: '0.1.0-rc.6',
      versions: {
        '0.1.0-rc.2': { status: 'supported', tuiCompatible: true, desktopCompatible: true, notes: 'Early RC' },
        '0.1.0-rc.3': { status: 'supported', tuiCompatible: true, desktopCompatible: true, notes: 'Cordis profile base' },
        '0.1.0-rc.6': { status: 'recommended', tuiCompatible: true, desktopCompatible: true, notes: 'Current verified official release' },
      }
    };
  }

  public getRecommendedVersion(): string {
    return this.matrix.latestTestedVersion;
  }

  /**
   * List all known versions and their local installation state
   */
  public listVersions(): VersionInfo[] {
    const known = Object.keys(this.matrix.versions);
    return known.map((v) => {
      const isInstalled = fs.existsSync(path.join(this.runtimeBaseDir, v));
      const meta = this.matrix.versions[v];
      return {
        version: v,
        isInstalled,
        isRecommended: v === this.matrix.latestTestedVersion,
        status: meta?.status || 'unknown',
        notes: meta?.notes,
      };
    });
  }

  /**
   * Get executable launch command for a given DSH version.
   * If version is not specifically installed in the local pool, returns npx launcher.
   */
  public getLaunchCommand(version?: string): { executable: string; args: string[] } {
    const targetVersion = version || this.matrix.latestTestedVersion;
    const localInstallPath = path.join(this.runtimeBaseDir, targetVersion, 'node_modules', '.bin', 'dsh');

    if (fs.existsSync(localInstallPath)) {
      return {
        executable: localInstallPath,
        args: ['web'],
      };
    }

    // Fallback to npx with pinned version
    return {
      executable: 'npx',
      args: ['-y', `@deepseek-ai/dsh@${targetVersion}`, 'web'],
    };
  }
}
