'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROBE_TIMEOUT_MS = 5000;
const FULL_PROBE_LINE = 'landlock: fully enforced';
const WRITE_MARKER = 'DSH_APP_UID_OK';
const HARDLINK_MARKER = 'DSH_HARDLINK_OK';
const PTY_MARKER = 'DSH_PTY_APP_UID_OK';
const WRITE_SCRIPT = 'require("node:fs").writeFileSync(process.argv[1], "DSH_APP_UID_OK")';

function requireDirectory(name, value) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(`android-app-uid-preflight: ${name} must be an absolute directory path`);
  }
  const real = fs.realpathSync.native(value);
  if (!fs.statSync(real).isDirectory()) {
    throw new Error(`android-app-uid-preflight: ${name} is not a directory`);
  }
  return real;
}

function requireExecutable(name, value) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(`android-app-uid-preflight: ${name} must be an absolute executable path`);
  }
  const real = fs.realpathSync.native(value);
  if (!fs.statSync(real).isFile()) {
    throw new Error(`android-app-uid-preflight: ${name} is not a file`);
  }
  fs.accessSync(real, fs.constants.X_OK);
  return real;
}

function runHardlinkProbe(appDataDir) {
  const root = fs.mkdtempSync(path.join(appDataDir, '.dsh-hardlink-preflight-'));
  try {
    const source = path.join(root, 'source');
    const linked = path.join(root, 'linked');
    fs.writeFileSync(source, HARDLINK_MARKER, { flag: 'wx' });
    fs.linkSync(source, linked);

    const sourceStat = fs.statSync(source);
    const linkedStat = fs.statSync(linked);
    if (sourceStat.dev !== linkedStat.dev || sourceStat.ino !== linkedStat.ino) {
      throw new Error('hard-link probe did not preserve inode identity');
    }
    if (sourceStat.nlink < 2 || linkedStat.nlink < 2) {
      throw new Error('hard-link probe did not produce a second link');
    }
    if (fs.readFileSync(linked, 'utf8') !== HARDLINK_MARKER) {
      throw new Error('hard-link probe content mismatch');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function checkedSpawn(spawn, launcher, args, options, label) {
  const result = spawn(launcher, args, options);
  if (result.error !== undefined) {
    throw new Error(`${label} spawn failed: ${result.error.message}`);
  }
  return result;
}

function runLandlockProbe(cacheDir, launcher, spawn, execPath, baseEnv) {
  const root = fs.mkdtempSync(path.join(cacheDir, '.dsh-landlock-preflight-'));
  const allowedDir = path.join(root, 'allowed');
  const deniedDir = path.join(root, 'denied');
  fs.mkdirSync(allowedDir);
  fs.mkdirSync(deniedDir);

  const childEnv = {
    ...baseEnv,
    HOME: allowedDir,
    TMPDIR: allowedDir,
    TMP: allowedDir,
    TEMP: allowedDir,
  };
  const common = {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
  };

  try {
    const probe = checkedSpawn(spawn, launcher, ['--probe'], common, 'Landlock full probe');
    const probeStdout = (probe.stdout ?? '').trim();
    const probeStderr = (probe.stderr ?? '').trim();
    if (probe.status !== 0 || probeStdout !== FULL_PROBE_LINE || probeStderr !== '') {
      throw new Error(
        `Landlock must be fully enforced under the APK app UID; status=${String(probe.status)} stdout=${JSON.stringify(probeStdout)} stderr=${JSON.stringify(probeStderr)}`,
      );
    }

    const allowedFile = path.join(allowedDir, 'allowed.txt');
    const allowed = checkedSpawn(
      spawn,
      launcher,
      ['--ro', '/', '--rw', '/dev/null', '--rw', allowedDir, '--', execPath, '-e', WRITE_SCRIPT, allowedFile],
      common,
      'Landlock allowed-write probe',
    );
    if (allowed.status !== 0 || fs.readFileSync(allowedFile, 'utf8') !== WRITE_MARKER) {
      throw new Error(
        `Landlock allowed-write probe failed under the APK app UID; status=${String(allowed.status)} stderr=${JSON.stringify((allowed.stderr ?? '').trim())}`,
      );
    }

    const deniedFile = path.join(deniedDir, 'denied.txt');
    const denied = checkedSpawn(
      spawn,
      launcher,
      ['--ro', '/', '--rw', '/dev/null', '--rw', allowedDir, '--', execPath, '-e', WRITE_SCRIPT, deniedFile],
      common,
      'Landlock denied-write probe',
    );
    const deniedStderr = (denied.stderr ?? '').trim();
    if (denied.status === 0 || fs.existsSync(deniedFile)) {
      throw new Error('Landlock denied-write probe unexpectedly wrote outside the granted directory');
    }
    if (!/(?:EACCES|EPERM|permission denied|operation not permitted)/iu.test(deniedStderr)) {
      throw new Error(
        `Landlock denied-write probe failed for an unrelated reason: status=${String(denied.status)} stderr=${JSON.stringify(deniedStderr)}`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runPtySubstrateProbe(cacheDir, options) {
  const procModule = options.procModule ?? await import('./android-process-inspector.mjs');
  const inspector = options.processInspector ?? procModule.createAndroidProcessInspector();
  const pty = options.ptyModule ?? await import('node-pty');
  const shell = options.ptyShell ?? '/system/bin/sh';
  const timeoutMs = options.ptyTimeoutMs ?? PROBE_TIMEOUT_MS;

  if (typeof shell !== 'string' || !path.isAbsolute(shell)) {
    throw new Error('android-app-uid-preflight: PTY shell must be an absolute path');
  }

  const terminal = pty.spawn(shell, ['-c', `printf ${PTY_MARKER}; sleep 1`], {
    name: 'dumb',
    rows: 20,
    cols: 80,
    cwd: cacheDir,
    env: {
      PATH: process.env.PATH ?? '/system/bin:/system/xbin',
      HOME: cacheDir,
      TMPDIR: cacheDir,
      TERM: 'dumb',
    },
  });

  let output = '';
  let exited = false;
  let dataDisposable;
  let exitDisposable;
  let timer;
  const completion = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('PTY app-UID probe timed out')), timeoutMs);
    dataDisposable = terminal.onData(data => { output += data; });
    exitDisposable = terminal.onExit(event => {
      exited = true;
      clearTimeout(timer);
      resolve(event);
    });
  });

  try {
    const rootStat = options.ptyRootStat?.(terminal.pid)
      ?? procModule.parseAndroidProcStat(fs.readFileSync(`/proc/${terminal.pid}/stat`, 'utf8'));
    if (rootStat === undefined) {
      throw new Error('PTY root /proc stat is not visible to the APK app UID');
    }
    if (
      rootStat.sessionId !== terminal.pid
      || !(rootStat.processGroupId > 1)
      || !(rootStat.foregroundProcessGroupId > 1)
      || rootStat.ttyDevice === 0
    ) {
      throw new Error(`PTY root has unusable session/group/tty facts: ${JSON.stringify(rootStat)}`);
    }

    const snapshot = inspector.snapshot();
    const rootIdentity = snapshot.tree(terminal.pid)
      .find(identity => identity.pid === terminal.pid);
    if (rootIdentity === undefined || !snapshot.alive(rootIdentity)) {
      throw new Error('PTY root identity is not enumerable/alive through app-visible /proc');
    }
    if (!snapshot.session(terminal.pid)
      .some(identity => identity.pid === terminal.pid && identity.started === rootIdentity.started)) {
      throw new Error('PTY root is not visible in its app-UID process session');
    }

    // Signal 0 is a visibility/permission probe only; no signal is delivered.
    inspector.signalGroup(rootStat.foregroundProcessGroupId, 0);

    await completion;
    if (!output.includes(PTY_MARKER)) {
      throw new Error(`PTY app-UID probe output mismatch: ${JSON.stringify(output)}`);
    }
  } finally {
    if (!exited) {
      try { terminal.kill('SIGKILL'); } catch {}
      await completion.catch(() => undefined);
    }
    clearTimeout(timer);
    dataDisposable?.dispose?.();
    exitDisposable?.dispose?.();
  }
}

async function runAndroidAppUidPreflight(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'android') {
    throw new Error(`android-app-uid-preflight: expected process.platform=android, observed ${platform}`);
  }

  const appDataDir = requireDirectory(
    'DSH_ANDROID_APP_DATA_DIR',
    options.appDataDir ?? process.env.DSH_ANDROID_APP_DATA_DIR,
  );
  const cacheDir = requireDirectory(
    'DSH_ANDROID_CACHE_DIR',
    options.cacheDir ?? process.env.DSH_ANDROID_CACHE_DIR,
  );
  const launcher = requireExecutable(
    'DSH_ANDROID_LANDLOCK_RUN',
    options.landlockLauncher ?? process.env.DSH_ANDROID_LANDLOCK_RUN,
  );

  runHardlinkProbe(appDataDir);
  runLandlockProbe(
    cacheDir,
    launcher,
    options.spawnSync ?? spawnSync,
    options.execPath ?? process.execPath,
    options.env ?? process.env,
  );
  await runPtySubstrateProbe(cacheDir, options);

  return {
    schemaVersion: 1,
    platform: 'android',
    arch: options.arch ?? process.arch,
    hardlink: 'PASS',
    sandbox: 'PASS',
    landlockEnforcement: 'full',
    ptySubstrate: 'PASS',
    ptyInputWaitingExactProbe: false,
  };
}

module.exports = {
  FULL_PROBE_LINE,
  HARDLINK_MARKER,
  PTY_MARKER,
  WRITE_MARKER,
  runAndroidAppUidPreflight,
  runPtySubstrateProbe,
};
