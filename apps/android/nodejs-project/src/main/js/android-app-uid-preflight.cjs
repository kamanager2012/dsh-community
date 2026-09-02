'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROBE_TIMEOUT_MS = 5000;
const FULL_PROBE_LINE = 'landlock: fully enforced';
const WRITE_MARKER = 'DSH_APP_UID_OK';
const HARDLINK_MARKER = 'DSH_HARDLINK_OK';
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

function runAndroidAppUidPreflight(options = {}) {
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

  return {
    schemaVersion: 1,
    platform: 'android',
    arch: options.arch ?? process.arch,
    hardlink: 'PASS',
    sandbox: 'PASS',
    landlockEnforcement: 'full',
  };
}

module.exports = {
  FULL_PROBE_LINE,
  HARDLINK_MARKER,
  WRITE_MARKER,
  runAndroidAppUidPreflight,
};
