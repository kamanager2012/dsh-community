#!/usr/bin/env node
/**
 * Real headless Chromium E2EE acceptance test for apps/remote-web PWA over
 * BlindGatewayServer + MultiAgentRemoteHost (Noise_IK_25519_ChaChaPoly_BLAKE2b).
 *
 * Optionally pass `--screenshots-dir docs/assets` to capture real rendered PNG
 * screenshots of the remote-web PWA and Desktop Remote Console UI.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  BlindGatewayServer,
  MultiAgentRemoteHost,
} from '../../packages/remote-adapter/dist/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')

function parseArgs(argv) {
  let chromePath = process.env.CHROME_BIN?.trim() || ''
  let screenshotsDir = ''
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--chrome' && argv[i + 1]) {
      chromePath = argv[i + 1]
      i += 1
    } else if (arg === '--screenshots-dir' && argv[i + 1]) {
      screenshotsDir = argv[i + 1]
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/e2e/remote-web-browser-e2ee.mjs [--chrome <bin>] [--screenshots-dir <dir>]\n',
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  return { chromePath, screenshotsDir }
}

function findChromeBinary(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) throw new Error(`Chrome binary not found: ${explicitPath}`)
    return explicitPath
  }
  for (const cmd of ['google-chrome', 'chromium', 'chromium-browser']) {
    try {
      const resolved = execFileSync('which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (resolved && existsSync(resolved)) return resolved
    } catch {
      // continue searching
    }
  }
  const msPlaywright = join(homedir(), '.cache', 'ms-playwright')
  if (existsSync(msPlaywright)) {
    const dirs = readdirSync(msPlaywright)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse()
    for (const dir of dirs) {
      for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const candidate = join(msPlaywright, dir, rel)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  throw new Error('Chromium/Chrome executable not found; pass --chrome <path> or set CHROME_BIN')
}

async function waitFor(label, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const val = await check()
      if (val) return val
    } catch (err) {
      lastError = err
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(
    `Timed out waiting for ${label} after ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`,
  )
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true })
    ws.addEventListener('error', (err) => rejectOpen(new Error(`CDP WebSocket error: ${err?.message ?? 'unknown'}`)), {
      once: true,
    })
  })
  let nextId = 0
  const pending = new Map()
  const listeners = new Set()
  ws.addEventListener('message', (evt) => {
    const msg = JSON.parse(String(evt.data))
    if (typeof msg.id === 'number') {
      const entry = pending.get(msg.id)
      if (entry) {
        pending.delete(msg.id)
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`))
        else entry.resolve(msg.result)
      }
    } else if (typeof msg.method === 'string') {
      for (const fn of listeners) fn(msg)
    }
  })
  const call = (method, params = {}) =>
    new Promise((resolveCall, rejectCall) => {
      const id = ++nextId
      pending.set(id, { method, resolve: resolveCall, reject: rejectCall })
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const res = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res?.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)
      throw new Error(`Page evaluate exception: ${detail}`)
    }
    return res?.result?.value
  }
  const onEvent = (fn) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }
  const close = () => {
    try {
      ws.close()
    } catch {
      // ignore
    }
  }
  return { call, evaluate, onEvent, close }
}

function createSampleGitWorkspace(root) {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src/auth.ts'),
    [
      'export function verifySessionExpiry(expiresAtMs: number, nowMs = Date.now()): boolean {',
      '  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs',
      '}',
      '',
    ].join('\n'),
  )
  execFileSync('git', ['init', '-b', 'feat/remote-e2ee-browser'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'DSH Community CI'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['add', 'src/auth.ts'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'chore: initial auth helper'], { cwd: root, stdio: 'ignore' })
  writeFileSync(
    join(root, 'src/auth.ts'),
    [
      'export function verifySessionExpiry(expiresAtMs: number, nowMs = Date.now()): boolean {',
      '  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return false',
      '  return expiresAtMs > nowMs',
      '}',
      '',
    ].join('\n'),
  )
}

function createMultiEngineBackends(workspaceRoot) {
  let seqCounter = 10
  const approvalsSeen = []

  const gitDiffText = [
    'diff --git a/src/auth.ts b/src/auth.ts',
    'index 1111111..2222222 100644',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -1,3 +1,4 @@',
    ' export function verifySessionExpiry(expiresAtMs: number, nowMs = Date.now()): boolean {',
    '-  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs',
    '+  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return false',
    '+  return expiresAtMs > nowMs',
    ' }',
  ].join('\n')

  const makeBackend = (engineId, displayName, sessionsList) => {
    const backendListeners = new Set()
    const emit = (sessionId, events) => {
      for (const listener of backendListeners) listener(sessionId, events)
    }
    return {
    engineId,
    displayName,
    probe: async () => ({
      id: engineId,
      displayName,
      available: true,
      running: true,
      capabilities: {
        createSession: true,
        listSessions: true,
        history: true,
        abortTurn: true,
        approvals: true,
        questions: true,
        streaming: true,
        models: true,
        gitReview: true,
      },
    }),
    onEvent: (listener) => {
      backendListeners.add(listener)
      return () => backendListeners.delete(listener)
    },
    listSessions: async () => sessionsList,
    assertSession: async (sessionId) => {
      if (!sessionsList.some((s) => s.id === sessionId)) throw new Error(`Unknown session ${sessionId}`)
    },
    getSessionHistory: async () => ({ events: [], hasMore: false }),
    createSession: async (opts) => ({
      id: `${engineId}--new-1`,
      engine: engineId,
      title: opts?.title ?? `New ${displayName} Session`,
      status: 'idle',
      cwd: workspaceRoot,
    }),
    followup: async (sessionId, prompt) => {
      const s1 = ++seqCounter
      const s2 = ++seqCounter
      const s3 = ++seqCounter
      setTimeout(() => {
        emit(sessionId, [
          { seq: s1, type: 'turn/start', data: {} },
          {
            seq: s2,
            type: 'assistant/message',
            data: {
              message: {
                content:
                  `Inspected **src/auth.ts** for \`${prompt}\`:\n\n` +
                  '- Added fail-closed `expiresAtMs <= 0` guard in `verifySessionExpiry`.\n' +
                  '- Ready to run workspace verification (`pnpm test`).',
              },
            },
          },
          {
            seq: s3,
            type: 'approval/request',
            data: {
              callId: 'call-auth-1',
              toolName: 'bash',
              args: { command: 'pnpm vitest run src/auth.test.ts' },
              reason: 'Run targeted unit test after updating verifySessionExpiry',
            },
          },
        ])
      }, 20)
      return { accepted: true }
    },
    respondApproval: async (callId, decision) => {
      approvalsSeen.push({ callId, decision })
      emit('claude--auth-1', [
        { seq: ++seqCounter, type: 'approval.resolved', data: { callId, decision } },
        { seq: ++seqCounter, type: 'turn/end', data: { reason: { kind: 'completed' } } },
      ])
      return { ok: true }
    },
    respondQuestion: async () => ({ ok: true }),
    getWorkspaceGitStatus: async ({ sessionId }) => ({
      sessionId,
      repoRoot: workspaceRoot,
      branch: 'feat/remote-e2ee-browser',
      ahead: 1,
      behind: 0,
      clean: false,
      files: [
        {
          path: 'src/auth.ts',
          indexStatus: ' ',
          worktreeStatus: 'M',
          staged: false,
          unstaged: true,
          untracked: false,
        },
      ],
      truncated: false,
    }),
    getWorkspaceGitDiff: async ({ sessionId, staged }) => ({
      sessionId,
      repoRoot: workspaceRoot,
      branch: 'feat/remote-e2ee-browser',
      staged: Boolean(staged),
      diff: gitDiffText,
      bytes: Buffer.byteLength(gitDiffText, 'utf8'),
      truncated: false,
    }),
    listWorkspaceFiles: async ({ sessionId }) => ({
      sessionId,
      root: workspaceRoot,
      files: ['src/auth.ts', 'README.md'],
      totalMatched: 2,
      truncated: false,
    }),
    listModels: async () => ({
      current: { provider: 'deepseek', model: 'deepseek-chat' },
      models: [{ provider: 'deepseek', model: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }],
    }),
    selectModel: async (_sessionId, selection) => ({ ok: true, selection }),
    listCommands: async () => [{ name: 'diff', description: 'Inspect workspace changes' }],
    executeCommand: async (_sessionId, command) => ({ ok: true, output: `Executed ${command}` }),
  }
  }

  return {
    approvalsSeen,
    backends: [
      makeBackend('claude', 'Claude Code', [
        {
          id: 'claude--auth-1',
          engine: 'claude',
          title: 'Harden Session Expiry Guard',
          status: 'idle',
          cwd: workspaceRoot,
          workspace: {
            repoRoot: workspaceRoot,
            branch: 'feat/remote-e2ee-browser',
            dirty: true,
            changedFiles: 1,
          },
        },
      ]),
      makeBackend('codex', 'Codex CLI', [
        {
          id: 'codex--cli-2',
          engine: 'codex',
          title: 'Verify Worktree Contracts',
          status: 'idle',
          cwd: workspaceRoot,
          workspace: {
            repoRoot: workspaceRoot,
            branch: 'main',
            dirty: false,
            changedFiles: 0,
          },
        },
      ]),
    ],
  }
}

async function renderDesktopRemoteHtml(repoRoot, issuedDeepLink, hostFingerprint, relayUrl, signalingUrl) {
  const { createRequire } = await import('node:module')
  const desktopRequire = createRequire(resolve(repoRoot, 'apps/desktop/package.json'))
  const esbuild = desktopRequire('esbuild')
  const bundleDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-render-'))
  try {
    const outFile = join(bundleDir, 'render.mjs')
    await esbuild.build({
      stdin: {
        contents: `
          export { renderRemotePage } from './apps/desktop/src/pages.ts';
          export { renderQrSvg } from './packages/dsh-bridge/src/qr.ts';
        `,
        resolveDir: repoRoot,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile: outFile,
      alias: {
        '@dsh-community/dsh-bridge': resolve(repoRoot, 'packages/dsh-bridge/src/index.ts'),
        '@dsh-community/shared-types': resolve(repoRoot, 'packages/shared-types/src/index.ts'),
      },
    })
    const mod = await import(pathToFileURL(outFile).href)
    const qrSvg = mod.renderQrSvg(issuedDeepLink, { margin: 2, size: 220 })
    const desktopHtml = mod.renderRemotePage({
      product: 'DSH Community',
      phase: 'running',
      pid: '48210',
      configDir: '~/.config/dsh-community/remote',
      dshHome: '~/.dsh',
      isolated: false,
      apiKeyPresent: true,
      hostFingerprint,
      lanCandidates: ['192.168.1.42'],
      effectiveListenHost: '192.168.1.42',
      settings: {
        listenHost: '192.168.1.42',
        port: 9443,
        enableMdns: true,
        relayUrl,
        signalingUrl,
        stunUrls: 'stun:stun.example.org:3478',
        engines: 'dsh,claude,codex,opencode',
      },
      engines: [
        { id: 'dsh', displayName: 'DeepSeek Harness', available: true, running: true },
        { id: 'claude', displayName: 'Claude Code', available: true, running: true },
        { id: 'codex', displayName: 'Codex CLI', available: true, running: true },
        { id: 'opencode', displayName: 'OpenCode ACP', available: false, running: false },
      ],
      lanUrl: 'ws://192.168.1.42:9443/remote',
      relayUrl,
      relayRoomId: 'room-e2ee-demo',
      signalingUrl,
      signalingRoomId: 'rtc-room-demo',
      stunUrls: ['stun:stun.example.org:3478'],
      activeConnections: 1,
      pendingApprovals: 1,
      pendingQuestions: 0,
      liveSessions: [
        {
          id: 'claude--auth-1',
          engine: 'claude',
          title: 'Harden Session Expiry Guard',
          status: 'running',
          preview: 'Waiting for remote E2EE approval: pnpm vitest run src/auth.test.ts',
          model: 'deepseek-chat',
          pendingApprovals: 1,
          pendingQuestions: 0,
          workspace: {
            repoRoot: '~/workspace/dsh-community',
            commonRepoRoot: '~/workspace/dsh-community',
            isWorktree: false,
            branch: 'feat/remote-e2ee-browser',
            dirty: true,
            changedFiles: 1,
            ahead: 1,
            behind: 0,
          },
        },
        {
          id: 'codex--cli-2',
          engine: 'codex',
          title: 'Verify Worktree Contracts',
          status: 'idle',
          preview: 'All upstream contract checks passing',
          model: 'gpt-5-codex',
          pendingApprovals: 0,
          pendingQuestions: 0,
          workspace: {
            repoRoot: '~/workspace/dsh-community-wt',
            commonRepoRoot: '~/workspace/dsh-community',
            isWorktree: true,
            branch: 'main',
            dirty: false,
            changedFiles: 0,
            ahead: 0,
            behind: 0,
          },
        },
      ],
      pairing: {
        deepLink: issuedDeepLink,
        pairingJson: JSON.stringify({ protocolVersion: 2, endpointUrl: 'ws://192.168.1.42:9443/remote' }),
        qrSvg,
        expiresAt: Date.now() + 300_000,
      },
      pendingCandidates: [],
      devices: [
        {
          deviceId: 'a91f48e2c7b19403',
          displayName: 'Remote Browser PWA (Noise IK)',
          capabilities: ['observe', 'prompt', 'approve', 'session.manage'],
          pairedAt: Date.now() - 120_000,
          lastSeenAt: Date.now() - 3_000,
        },
      ],
      gitPreview: {
        sessionId: 'claude--auth-1',
        repoRoot: '~/workspace/dsh-community',
        branch: 'feat/remote-e2ee-browser',
        ahead: 1,
        behind: 0,
        clean: false,
        staged: false,
        files: [
          {
            path: 'src/auth.ts',
            indexStatus: ' ',
            worktreeStatus: 'M',
            staged: false,
            unstaged: true,
            untracked: false,
          },
        ],
        diffPath: 'src/auth.ts',
        diffText:
          'diff --git a/src/auth.ts b/src/auth.ts\n@@ -1,3 +1,4 @@\n export function verifySessionExpiry(expiresAtMs: number, nowMs = Date.now()): boolean {\n-  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs\n+  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return false\n+  return expiresAtMs > nowMs\n }\n',
        bytes: 215,
        truncated: false,
      },
      logs: '',
      notice: 'Multi-Agent Remote Host ready (Noise_IK_25519_ChaChaPoly_BLAKE2b)',
    })
    return desktopHtml
  } finally {
    rmSync(bundleDir, { recursive: true, force: true })
  }
}

async function main() {
  const { chromePath, screenshotsDir } = parseArgs(process.argv.slice(2))
  const chromeBin = findChromeBinary(chromePath)
  const webDist = resolve(REPO_ROOT, 'apps/remote-web/dist')
  if (!existsSync(join(webDist, 'index.html'))) {
    throw new Error(`Built remote-web assets missing at ${webDist}; run pnpm --filter @dsh-community/remote-web build`)
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-browser-e2ee-'))
  const workDir = join(sandbox, 'dsh-community')
  const profileDir = join(sandbox, 'chrome-profile')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(profileDir, { recursive: true })
  createSampleGitWorkspace(workDir)

  const gateway = new BlindGatewayServer({
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    webAppDir: webDist,
  })
  const mock = createMultiEngineBackends(workDir)
  let host
  let chromeProc
  let cdp

  try {
    await gateway.start()
    const webAppUrl = gateway.getWebAppUrl()
    const relayUrl = gateway.getRelayEndpointUrl()
    const signalingUrl = gateway.getSignalingEndpointUrl()
    if (!webAppUrl || !relayUrl || !signalingUrl) {
      throw new Error('BlindGatewayServer failed to bind /app/, /relay, or /signal endpoints')
    }

    host = new MultiAgentRemoteHost({
      dshHome: join(sandbox, 'dsh-home'),
      configDir: join(sandbox, 'remote-config'),
      cwd: workDir,
      backends: mock.backends,
      autoConfirmCapabilities: [
        'observe',
        'prompt',
        'approve',
        'answer-question',
        'session.manage',
        'command.execute',
      ],
      carrier: { enabled: true, host: '127.0.0.1', port: 0 },
      relayUrl,
      signalingUrl,
    })
    await host.start()

    const issued = await host.issuePairingDescriptor({
      allowedCapabilities: ['observe', 'prompt', 'approve', 'session.manage', 'command.execute'],
    })
    const encodedPair = new URL(issued.deepLink).searchParams.get('data')
    if (!encodedPair) throw new Error('Missing data parameter on pairing deep link')
    const targetUrl = `${webAppUrl}#pair=${encodedPair}`

    let wsEndpoint = ''
    chromeProc = spawn(
      chromeBin,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        '--window-size=1280,860',
        targetUrl,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const stderrChunks = []
    chromeProc.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      stderrChunks.push(text)
      if (!wsEndpoint) {
        const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/)
        if (match?.[1]) wsEndpoint = match[1]
      }
    })

    await waitFor('Chromium DevTools endpoint', 20_000, async () => wsEndpoint)
    const debugHttpOrigin = new URL(wsEndpoint).origin.replace(/^ws:/, 'http:')
    const pageTarget = await waitFor('remote-web page target', 15_000, async () => {
      const res = await fetch(`${debugHttpOrigin}/json/list`)
      if (!res.ok) return null
      const targets = await res.json()
      return targets.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:'))
    })

    cdp = await connectCdp(pageTarget.webSocketDebuggerUrl)
    await cdp.call('Runtime.enable')
    await cdp.call('Page.enable')
    await cdp.call('Log.enable')

    const pageErrors = []
    cdp.onEvent((evt) => {
      if (evt.method === 'Runtime.exceptionThrown') {
        pageErrors.push(evt.params?.exceptionDetails?.text || 'Runtime.exceptionThrown')
      } else if (evt.method === 'Log.entryAdded' && evt.params?.entry?.level === 'error') {
        pageErrors.push(evt.params.entry.text || 'Log.error')
      }
    })

    try {
      await waitFor('Noise IK pairing completion and URL hash scrub', 20_000, async () =>
        cdp.evaluate(`(() => {
          const text = document.body?.innerText || '';
          const items = document.querySelectorAll('button.session-item');
          if (items.length < 2) return null;
          return {
            hash: location.hash,
            sessionsCount: items.length,
            hasText: text.includes('Harden Session Expiry Guard'),
          };
        })()`),
      )
    } catch (waitErr) {
      const snap = await cdp.evaluate(`({ href: location.href, text: document.body?.innerText || '', html: document.body?.innerHTML?.slice(0, 1200) || '' })`).catch(() => null)
      throw new Error(`${waitErr.message}\nPage snapshot: ${JSON.stringify(snap)}\nPageErrors: ${JSON.stringify(pageErrors)}`)
    }

    const currentHash = await cdp.evaluate('location.hash')
    if (String(currentHash).includes('pair=')) {
      throw new Error(`Security regression: #pair= fragment was not scrubbed from URL (${currentHash})`)
    }

    await cdp.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('button.session-item'))
        .find((el) => el.textContent && el.textContent.includes('Harden Session Expiry Guard'));
      if (!btn) throw new Error('Missing target session button');
      btn.click();
      return true;
    })()`)

    await waitFor('composer textarea active', 10_000, async () =>
      cdp.evaluate(`(() => {
        const ta = document.querySelector('#composer-slot textarea.composer-textarea');
        const send = document.querySelector('#composer-slot button[type="submit"]');
        return Boolean(ta && send && !send.disabled);
      })()`),
    )

    await cdp.evaluate(`(() => {
      const ta = document.querySelector('#composer-slot textarea.composer-textarea');
      ta.value = 'verify session expiry helper';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const send = document.querySelector('#composer-slot button[type="submit"]');
      send.click();
      return true;
    })()`)

    await waitFor('assistant reply + approval card', 15_000, async () =>
      cdp.evaluate(`(() => {
        const text = document.body?.innerText || '';
        const allow = Array.from(document.querySelectorAll('button'))
          .find((el) => el.textContent?.trim() === 'Allow Once');
        if (!allow || !text.includes('verifySessionExpiry')) return null;
        return { hasApproval: true };
      })()`),
    )

    if (screenshotsDir) {
      const absOutDir = resolve(REPO_ROOT, screenshotsDir)
      mkdirSync(absOutDir, { recursive: true })
      const pwaShot = await cdp.call('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(absOutDir, 'remote-web-pwa.png'), Buffer.from(pwaShot.data, 'base64'))
    }

    await cdp.evaluate(`(() => {
      const allow = Array.from(document.querySelectorAll('button'))
        .find((el) => el.textContent?.trim() === 'Allow Once');
      if (!allow) throw new Error('Missing Allow Once button');
      allow.click();
      return true;
    })()`)

    await waitFor('host received E2EE approval', 10_000, async () =>
      mock.approvalsSeen.some((a) => a.callId === 'call-auth-1' && a.decision === 'approved'),
    )

    await cdp.evaluate(`(() => {
      const diffTab = Array.from(document.querySelectorAll('button.tab-btn'))
        .find((el) => (el.textContent || '').includes('Diff'));
      if (!diffTab) throw new Error('Missing Diff tab button');
      diffTab.click();
      return true;
    })()`)

    try {
      await waitFor('Git diff panel rendered over Noise IK', 10_000, async () =>
        cdp.evaluate(`(() => {
          const text = document.body?.innerText || '';
          return text.includes('src/auth.ts') && text.includes('verifySessionExpiry') && text.includes('Unstaged');
        })()`),
      )
    } catch (diffErr) {
      const diffSnap = await cdp.evaluate(`({ text: document.body?.innerText || '', html: document.body?.innerHTML?.slice(0, 1500) || '' })`).catch(() => null)
      throw new Error(`${diffErr.message}\nDiff snapshot: ${JSON.stringify(diffSnap)}\nPageErrors: ${JSON.stringify(pageErrors)}`)
    }

    if (screenshotsDir) {
      const desktopHtml = await renderDesktopRemoteHtml(
        REPO_ROOT,
        issued.deepLink,
        issued.descriptor.hostFingerprint,
        'wss://relay.dsh-community.local/relay',
        'wss://relay.dsh-community.local/signal',
      )
      await cdp.call('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 920,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await cdp.call('Page.navigate', {
        url: `data:text/html;charset=utf-8,${encodeURIComponent(desktopHtml)}`,
      })
      await waitFor('Desktop remote console rendered', 10_000, async () =>
        cdp.evaluate(`(() => {
          const text = document.body?.innerText || '';
          return text.includes('扫码配对手机客户端') && text.includes('src/auth.ts') && document.querySelectorAll('svg').length >= 1;
        })()`),
      )
      const desktopShot = await cdp.call('Page.captureScreenshot', { format: 'png' })
      writeFileSync(
        join(resolve(REPO_ROOT, screenshotsDir), 'desktop-remote-console.png'),
        Buffer.from(desktopShot.data, 'base64'),
      )
    }

    if (pageErrors.length > 0) {
      throw new Error(`Browser console/page errors observed: ${pageErrors.join(' | ')}`)
    }

    const stats = gateway.getStats()
    console.log(
      JSON.stringify(
        {
          status: 'PASS',
          chromeBin,
          gatewayWebRequests: stats.webAppRequests,
          approvalsSeen: mock.approvalsSeen,
          hashScrubbed: true,
          gitDiffRendered: true,
          screenshotsDir: screenshotsDir || null,
          pageErrors: pageErrors.length,
        },
        null,
        2,
      ),
    )
  } finally {
    if (cdp) cdp.close()
    if (chromeProc && chromeProc.exitCode === null) {
      chromeProc.kill('SIGKILL')
    }
    if (host) await host.stop().catch(() => {})
    await gateway.stop().catch(() => {})
    rmSync(sandbox, { recursive: true, force: true })
  }
}

await main()
