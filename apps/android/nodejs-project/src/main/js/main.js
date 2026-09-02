'use strict';

/**
 * Embedded runtime bootstrap for nodejs-mobile.
 *
 * Launches the official DeepSeek Harness CLI on explicit loopback with `--no-open` from
 * the bundled node_modules, mirroring the desktop thin-shell pattern:
 * the official runtime owns the agent loop, this project only hosts it.
 *
 * Reality Gate note: no capability here is [REAL] until scripts/termux-verify.sh
 * passes on a real device with the pinned @deepseek-ai/dsh version.
 */

const { spawn } = require('child_process');
const path = require('path');
const { runAndroidAppUidPreflight } = require('./android-app-uid-preflight.cjs');

const RUNTIME_PORT = Number(process.env.DSH_RUNTIME_PORT || 17890);
if (!Number.isInteger(RUNTIME_PORT) || RUNTIME_PORT < 1 || RUNTIME_PORT > 65535) {
  throw new Error('DSH_RUNTIME_PORT must be an integer from 1 to 65535');
}
const DSH_BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'dsh');
const ANDROID_PATCH = path.join(__dirname, 'android.cordis.patch.yml');
const LANDLOCK_RUN = process.env.DSH_ANDROID_LANDLOCK_RUN
  || path.join(__dirname, 'bin', 'landlock-run');

async function main() {
  const appUidPreflight = await runAndroidAppUidPreflight({
    appDataDir: process.env.DSH_ANDROID_APP_DATA_DIR,
    cacheDir: process.env.DSH_ANDROID_CACHE_DIR,
    landlockLauncher: LANDLOCK_RUN,
  });
  process.stdout.write(`[dsh-android] APP_UID_PREFLIGHT_OK ${JSON.stringify(appUidPreflight)}\\n`);

  const child = spawn(
    DSH_BIN,
    [
      'web',
      '--patch', ANDROID_PATCH,
      '--host', '127.0.0.1',
      '--port', String(RUNTIME_PORT),
      '--no-open',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DSH_ANDROID_LANDLOCK_RUN: LANDLOCK_RUN,
      },
    },
  );

  child.stdout.on('data', (d) => process.stdout.write(`[dsh] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[dsh] ${d}`));

  child.on('error', (err) => {
    console.error('[dsh-android] failed to start official runtime:', err.message);
    process.exitCode = 1;
  });

  child.on('exit', (code) => {
    console.error(`[dsh-android] official runtime exited (code=${code})`);
    process.exit(code ?? 1);
  });

  process.on('SIGTERM', () => child.kill('SIGTERM'));

}

void main().catch((error) => {
  console.error('[dsh-android] substrate preflight failed:', error);
  process.exitCode = 1;
});
