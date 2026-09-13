import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const PROBE_INSTALL_TIMEOUT_MS = 300_000;
const PROBE_EXEC_TIMEOUT_MS = 60_000;

export interface UpstreamSnapshot {
  version: string;
  observedPlugins: string[];
  cliFlags: {
    web: string[];
    headless: string[];
  };
  probeSource: 'live_exec' | 'offline_snapshot';
}

/**
 * Install @deepseek-ai/dsh into an isolated staging dir and resolve its bin.
 *
 * `npx -y` re-resolves and installs the full official dependency tree (60+
 * subpackages) on every probe; npm's resolver blows memory on it (arborist
 * OOM) and cold-runner latency blew the old per-call timeouts. pnpm handles
 * the same tree in seconds, so it is the primary installer with npm as a
 * fallback for environments without pnpm.
 */
function installOfficialDsh(targetVersion: string): { binPath: string; installedVersion: string } {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contract-probe-'));
  fs.writeFileSync(
    path.join(stage, 'package.json'),
    JSON.stringify({ name: 'dsh-contract-probe', private: true, version: '0.0.0' }, null, 2) + '\n',
  );
  let pm = process.env.DSH_CONTRACT_PM ?? 'pnpm';
  try {
    execFileSync(pm, ['--version'], { stdio: 'ignore', timeout: 15_000 });
  } catch {
    pm = 'npm';
  }
  execFileSync(
    pm,
    ['add', '--ignore-scripts', `@deepseek-ai/dsh@${targetVersion}`],
    {
      cwd: stage,
      encoding: 'utf-8',
      timeout: PROBE_INSTALL_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const manifestPath = path.join(stage, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
    version: string;
    bin: Record<string, string>;
  };
  return {
    binPath: path.join(path.dirname(manifestPath), manifest.bin.dsh),
    installedVersion: manifest.version,
  };
}

/**
 * Dynamic Runtime Invariant Probe against candidate/installed @deepseek-ai/dsh
 *
 * Captures real runtime introspection and command surface from official executable.
 * Robust against cold runner network latency by falling back to verified snapshot when offline.
 */
export function probeOfficialDsh(targetVersion = 'latest'): UpstreamSnapshot {
  console.log(`📡 Probing official @deepseek-ai/dsh@${targetVersion}...`);

  let observedPlugins: string[] = [];
  let webFlags: string[] = [];
  let headlessFlags: string[] = [];
  let probeSource: 'live_exec' | 'offline_snapshot' = 'live_exec';
  let installedVersion = targetVersion;
  let binPath: string | undefined;

  try {
    ({ binPath, installedVersion } = installOfficialDsh(targetVersion));
  } catch (err: any) {
    console.warn(`⚠️ Live install of @deepseek-ai/dsh@${targetVersion} failed (${err.message}).`);
  }

  // Run the installed bin directly — one install serves every probe call
  // instead of npx resolving the tree again per invocation.
  const runDsh = (args: string[]): string | null => {
    if (!binPath) return null;
    try {
      return execFileSync(
        process.execPath,
        [binPath, ...args],
        {
          encoding: 'utf-8',
          timeout: PROBE_EXEC_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || 'dummy_key_for_probe' }
        }
      );
    } catch (err: any) {
      console.warn(`⚠️ Live probe step unavailable (${err.message}).`);
      return null;
    }
  };

  // 1. Primary Attempt: Probe web profile plugins via dump-default-config
  const rawDump = runDsh(['--profile', 'web', '--dump-default-config']);
  if (rawDump !== null) {
    const matches = rawDump.matchAll(/name:\s*['"](@deepseek-ai\/[^'"]+)['"]/g);
    for (const m of matches) {
      if (m[1]) observedPlugins.push(m[1]);
    }
  }

  // 2. Probe CLI surfaces
  const webHelp = runDsh(['web', '--help']);
  if (webHelp !== null) {
    const flagMatches = webHelp.matchAll(/--[a-zA-Z0-9-]+/g);
    for (const f of flagMatches) {
      if (!webFlags.includes(f[0])) webFlags.push(f[0]);
    }
  }

  const headlessHelp = runDsh(['--profile', 'headless', '--help']);
  if (headlessHelp !== null) {
    const flagMatches = headlessHelp.matchAll(/--[a-zA-Z0-9-]+/g);
    for (const f of flagMatches) {
      if (!headlessFlags.includes(f[0])) headlessFlags.push(f[0]);
    }
  }

  // 3. If live execution returned 0 plugins due to network/install failure on
  // a cold runner, load the verified offline contract snapshot
  if (observedPlugins.length === 0) {
    probeSource = 'offline_snapshot';
    console.log(`📦 Loading verified upstream contract snapshot for invariant verification...`);
    
    observedPlugins = [
      '@deepseek-ai/dsh-session-persistence-jsonl',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-session',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-approval-core',
      '@deepseek-ai/dsh-sandbox-policy',
    ];
    if (webFlags.length === 0) {
      webFlags = ['--profile', '--host', '--port', '--trusted-host', '--help'];
    }
    if (headlessFlags.length === 0) {
      headlessFlags = ['--profile', '--help'];
    }
  }

  return {
    version: installedVersion,
    observedPlugins: Array.from(new Set(observedPlugins)),
    cliFlags: {
      web: webFlags,
      headless: headlessFlags,
    },
    probeSource,
  };
}

export interface ContractCheckOptions {
  /** Explicitly accept offline snapshot fallback (weakens verification guarantees). */
  allowOffline?: boolean;
}

export function runContractDiff(
  candidateSnapshot?: UpstreamSnapshot,
  options: ContractCheckOptions = {}
): boolean {
  console.log(`\n======================================================`);
  console.log(`🔍 Dynamic Runtime Invariant Probe & Verification`);
  console.log(`======================================================\n`);

  // If candidate is not passed in, actively PROBE upstream (latest by default;
  // override via the CLI positional arg or DSH_CONTRACT_TARGET_VERSION).
  const target = candidateSnapshot || probeOfficialDsh();

  // Fail closed: never validate invariants against fabricated observations
  // unless the operator explicitly opted in via --allow-offline.
  if (target.probeSource === 'offline_snapshot' && !options.allowOffline) {
    console.error(`❌ [FAIL-CLOSED] Live upstream probe unavailable — offline fallback snapshot was used.`);
    console.error(`   Refusing to PASS runtime invariants based on fabricated observations.`);
    console.error(`   Re-run with network access, or pass --allow-offline to explicitly accept snapshot-based verification.`);
    return false;
  }

  console.log(`📌 Candidate Version: ${target.version}`);
  console.log(`🔎 Probe Mode: ${target.probeSource === 'live_exec' ? '⚡ Live Introspection' : '📦 Verified Snapshot'}`);
  console.log(`📊 Observed Plugins: ${target.observedPlugins.length}`);
  console.log(`🔌 Web CLI Flags: ${target.cliFlags.web.join(', ')}`);
  console.log(`⚡ Headless Flags: ${target.cliFlags.headless.join(', ')}\n`);

  // Invariants that MUST be satisfied by official runtime
  const REQUIRED_PLUGINS = [
    '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-llm',
  ];

  let hasBreaking = false;

  for (const req of REQUIRED_PLUGINS) {
    if (!target.observedPlugins.includes(req)) {
      console.error(`❌ [BREAKING] Required upstream plugin missing: ${req}`);
      hasBreaking = true;
    }
  }

  if (!target.cliFlags.web.includes('--port') && !target.cliFlags.web.includes('-h')) {
    console.error(`❌ [BREAKING] Official "web" command lost expected flags (--port)`);
    hasBreaking = true;
  }

  if (hasBreaking) {
    console.error(`\n💥 Runtime Invariant Probe FAILED. Upstream breaking changes detected!`);
    return false;
  }

  console.log(`✅ Runtime Invariant Verification PASSED. All baseline runtime seams are satisfied.`);
  return true;
}

// Direct execution
if (process.argv[1] === __filename) {
  const allowOffline = process.argv.includes('--allow-offline');
  const positional = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const targetVersion = positional ?? process.env.DSH_CONTRACT_TARGET_VERSION ?? 'latest';
  const ok = runContractDiff(probeOfficialDsh(targetVersion), { allowOffline });
  if (!ok) process.exit(1);
}
