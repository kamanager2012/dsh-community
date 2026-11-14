#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEVTOOLS_RE = /DevTools listening on (ws:\/\/[^\s]+)/u

export function parseSmokeArgs(argv) {
  let executable = ''
  let timeoutMs = 90_000
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--executable' && argv[i + 1]) {
      executable = argv[i + 1]
      i += 1
    } else if (arg === '--timeout-ms' && argv[i + 1]) {
      const parsed = Number(argv[i + 1])
      if (Number.isFinite(parsed) && parsed >= 5_000) timeoutMs = parsed
      i += 1
    }
  }
  return { executable, timeoutMs }
}

export function parseDevToolsWsUrl(text) {
  const match = text.match(DEVTOOLS_RE)
  return match?.[1]
}

export function selectMainShellTarget(targets) {
  if (!Array.isArray(targets)) return undefined
  return targets.find((target) => {
    if (!target || typeof target !== 'object') return false
    if (target.type !== 'page' || typeof target.url !== 'string') return false
    if (!target.url.startsWith('data:text/html;charset=utf-8,')) return false
    try {
      const html = decodeURIComponent(target.url.slice('data:text/html;charset=utf-8,'.length))
      return html.includes('window.dshCommunity')
    } catch {
      return false
    }
  })
}

export function findOfficialWebOrigin(targets) {
  if (!Array.isArray(targets)) return undefined
  for (const target of targets) {
    if (!target || typeof target !== 'object' || typeof target.url !== 'string') continue
    try {
      const url = new URL(target.url)
      if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== '') {
        return url.origin
      }
    } catch {
      // ignore non-HTTP targets
    }
  }
  return undefined
}

export function validateRemotePairingDeepLink(deepLink, pairingJsonText) {
  if (typeof deepLink !== 'string' || !deepLink.startsWith('dsh-remote://pair')) {
    throw new Error(`Invalid pairing deep link prefix: ${String(deepLink)}`)
  }
  const url = new URL(deepLink)
  const encoded = url.searchParams.get('data')
  if (!encoded) {
    throw new Error('Pairing deep link missing data query parameter')
  }
  const descriptor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  if (typeof descriptor !== 'object' || descriptor === null) {
    throw new Error('Decoded pairing descriptor is not an object')
  }
  if (
    typeof descriptor.protocolVersion !== 'number'
    || !Number.isInteger(descriptor.protocolVersion)
    || descriptor.protocolVersion < 1
  ) {
    throw new Error(`Pairing descriptor missing valid protocolVersion: ${String(descriptor.protocolVersion)}`)
  }
  if (typeof descriptor.endpointUrl !== 'string' || !/^ws:\/\/127\.0\.0\.1:\d+(?:\/|$)/u.test(descriptor.endpointUrl)) {
    throw new Error(`Unexpected loopback endpointUrl in pairing descriptor: ${String(descriptor.endpointUrl)}`)
  }
  if (typeof descriptor.bootstrapToken !== 'string' || descriptor.bootstrapToken.length < 16) {
    throw new Error('Pairing descriptor missing valid bootstrapToken')
  }
  if (typeof descriptor.hostFingerprint !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(descriptor.hostFingerprint)) {
    throw new Error('Pairing descriptor missing valid hostFingerprint')
  }
  if (typeof descriptor.hostPublicKeyHex !== 'string' || !/^[0-9a-fA-F]{64}$/u.test(descriptor.hostPublicKeyHex)) {
    throw new Error('Pairing descriptor missing valid hostPublicKeyHex')
  }
  if (typeof descriptor.expiresAt !== 'number' || !Number.isFinite(descriptor.expiresAt) || descriptor.expiresAt <= 0) {
    throw new Error('Pairing descriptor missing numeric expiresAt')
  }
  if (pairingJsonText !== undefined && pairingJsonText !== '') {
    const rawJson = JSON.parse(pairingJsonText)
    if (
      rawJson.protocolVersion !== descriptor.protocolVersion
      || rawJson.bootstrapToken !== descriptor.bootstrapToken
      || rawJson.endpointUrl !== descriptor.endpointUrl
      || rawJson.hostPublicKeyHex !== descriptor.hostPublicKeyHex
      || rawJson.hostFingerprint !== descriptor.hostFingerprint
    ) {
      throw new Error('Mismatch between DOM pairingJson and deep-link descriptor')
    }
  }
  return descriptor
}

/** Sends a signal to the entire spawned process group on POSIX when detached, falling back to pid. */
export function killProcessTree(child, signal = 'SIGKILL', { forceGroup = false } = {}) {
  if (!child || typeof child.pid !== 'number') return
  const stillRunning = child.exitCode === null && child.signalCode === null
  if (!stillRunning && !forceGroup) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through if the process is no longer a process-group leader.
    }
  }
  if (stillRunning) {
    try {
      child.kill(signal)
    } catch {
      // Ignore already exited child processes.
    }
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function raceWithTimeout(promise, timeoutMs, fallbackValue) {
  let timer
  const timeoutPromise = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(fallbackValue), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer)
  })
}

async function waitForTcpReachable(urlString, timeoutMs = 10_000) {
  const url = new URL(urlString)
  const port = Number(url.port)
  const host = url.hostname
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    const ok = await new Promise((resolveProbe) => {
      const sock = createConnection({ host, port })
      const done = (connected, errMsg) => {
        sock.removeAllListeners()
        sock.destroy()
        if (errMsg) lastError = errMsg
        resolveProbe(connected)
      }
      sock.setTimeout(1_500, () => done(false, 'TCP probe timeout'))
      sock.once('connect', () => done(true))
      sock.once('error', (err) => done(false, err.message))
    })
    if (ok) return
    await sleep(150)
  }
  throw new Error(`TCP endpoint unreachable (${urlString}): ${lastError}`)
}

async function assertTcpRefused(urlString, timeoutMs = 10_000) {
  const url = new URL(urlString)
  const port = Number(url.port)
  const host = url.hostname
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const connected = await new Promise((resolveProbe) => {
      const sock = createConnection({ host, port })
      const done = (value) => {
        sock.removeAllListeners()
        sock.destroy()
        resolveProbe(value)
      }
      sock.setTimeout(1_000, () => done(false))
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
    })
    if (!connected) return
    await sleep(150)
  }
  throw new Error(`Expected TCP endpoint to be stopped/refused, but ${urlString} still accepted connections`)
}

async function connectCdp(wsUrl, { onRuntimeError = undefined } = {}) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error(`CDP WebSocket open timeout: ${wsUrl}`)), 10_000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolveOpen()
    }, { once: true })
    ws.addEventListener('error', (ev) => {
      clearTimeout(timer)
      const detail = ev && typeof ev === 'object' && 'message' in ev ? ev.message : ev
      rejectOpen(new Error(`CDP WebSocket open error: ${String(detail)}`))
    }, { once: true })
  })

  let nextId = 1
  const pending = new Map()

  ws.addEventListener('message', (event) => {
    let msg
    try {
      msg = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (typeof msg.id === 'number') {
      const entry = pending.get(msg.id)
      if (!entry) return
      pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) {
        entry.reject(new Error(`${entry.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`))
      } else {
        entry.resolve(msg.result)
      }
      return
    }
    if (msg.method === 'Runtime.exceptionThrown' && onRuntimeError) {
      const details = msg.params?.exceptionDetails
      const desc = details?.exception?.description ?? details?.text ?? 'Unknown renderer exception'
      onRuntimeError(`Renderer exceptionThrown: ${desc}`)
    } else if (msg.method === 'Log.entryAdded' && onRuntimeError) {
      const entry = msg.params?.entry
      if (entry && (entry.source === 'security' || entry.level === 'error')) {
        onRuntimeError(`Renderer Log [${entry.source}/${entry.level}]: ${entry.text ?? ''}`)
      }
    } else if (msg.method === 'Runtime.consoleAPICalled' && onRuntimeError) {
      const p = msg.params
      if (p?.type === 'error') {
        const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
        onRuntimeError(`Renderer console.error: ${text}`)
      }
    }
  })

  function clearPending(reason) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason(entry.method)))
      pending.delete(id)
    }
  }

  ws.addEventListener('close', () => {
    clearPending((method) => `CDP closed before ${method} replied`)
  })

  function call(method, params = {}, timeoutMs = 15_000) {
    return new Promise((resolveCall, rejectCall) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectCall(new Error(`CDP call timeout (${method})`))
      }, timeoutMs)
      pending.set(id, { method, resolve: resolveCall, reject: rejectCall, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(expression) {
    const res = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (res?.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'evaluate exception'
      throw new Error(`Runtime.evaluate exception: ${desc}`)
    }
    return res?.result?.value
  }

  return {
    call,
    evaluate,
    close: () => {
      clearPending((method) => `CDP client closed before ${method} replied`)
      try {
        ws.close()
      } catch {}
    },
  }
}

async function waitForCondition(label, timeoutMs, errors, probeFn) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    if (errors.length > 0) {
      throw new Error(`Renderer security/runtime errors observed while waiting for [${label}]:\n${errors.join('\n')}`)
    }
    try {
      const value = await probeFn()
      if (value) return value
      lastError = undefined
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // Rapid BrowserWindow.loadURL transitions recreate execution contexts cleanly.
      if (
        msg.includes('Execution context was destroyed')
        || msg.includes('Cannot find context with specified id')
      ) {
        lastError = msg
      } else {
        throw error
      }
    }
    await sleep(200)
  }
  throw new Error(`Timed out after ${String(timeoutMs)}ms waiting for [${label}]${lastError ? ` (last: ${lastError})` : ''}`)
}

export async function runAppImageGuiSmoke({ executable, timeoutMs = 90_000 }) {
  if (!executable || !existsSync(executable)) {
    throw new Error(`Packaged executable not found: ${String(executable)}`)
  }

  const sandboxRoot = mkdtempSync(join(tmpdir(), 'dsh-appimage-gui-smoke-'))
  const homeDir = join(sandboxRoot, 'home')
  const configDir = join(sandboxRoot, 'xdg-config')
  const dataDir = join(sandboxRoot, 'xdg-data')
  const userDataDir = join(sandboxRoot, 'electron-userdata')
  const workspaceDir = join(sandboxRoot, 'workspace')
  for (const dir of [homeDir, configDir, dataDir, userDataDir, workspaceDir]) {
    mkdirSync(dir, { recursive: true })
  }

  const stderrLines = []
  const stdoutLines = []
  const rendererErrors = []

  const childEnv = { ...process.env }
  delete childEnv.DSH_HOME
  delete childEnv.DSH_COMMUNITY_BIN
  delete childEnv.DSH_DESKTOP_NODE_EXECUTABLE
  delete childEnv.DSH_REMOTE_CONFIG_DIR
  childEnv.HOME = homeDir
  childEnv.XDG_CONFIG_HOME = configDir
  childEnv.XDG_DATA_HOME = dataDir
  childEnv.TMPDIR = sandboxRoot
  childEnv.DSH_COMMUNITY_ISOLATED = '1'
  childEnv.DSH_DESKTOP_CWD = workspaceDir
  childEnv.DEEPSEEK_API_KEY = 'sk-test-appimage-gui-smoke'

  const child = spawn(
    executable,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
    ],
    {
      cwd: workspaceDir,
      env: childEnv,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let browserWsUrl
  child.stdout?.on('data', (chunk) => {
    stdoutLines.push(String(chunk))
    if (stdoutLines.length > 200) stdoutLines.shift()
  })
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk)
    stderrLines.push(text)
    if (stderrLines.length > 200) stderrLines.shift()
    if (!browserWsUrl) {
      browserWsUrl = parseDevToolsWsUrl(text)
    }
  })

  const exitPromise = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })

  let browserCdp
  let pageCdp
  let officialOrigin
  let firstRemoteEndpointUrl
  let cleanExit = false

  try {
    await waitForCondition('DevTools WebSocket URL', 30_000, rendererErrors, async () => {
      if (child.exitCode !== null) {
        throw new Error(`AppImage binary exited early with code ${String(child.exitCode)}`)
      }
      return browserWsUrl
    })

    const debugOrigin = new URL(browserWsUrl).origin.replace(/^ws:/u, 'http:')
    browserCdp = await connectCdp(browserWsUrl)

    const shellTarget = await waitForCondition('Main Electron shell window target', 30_000, rendererErrors, async () => {
      const res = await fetch(`${debugOrigin}/json/list`, { signal: AbortSignal.timeout(5_000) })
      if (!res.ok) return undefined
      const targets = await res.json()
      return selectMainShellTarget(targets)
    })

    pageCdp = await connectCdp(shellTarget.webSocketDebuggerUrl, {
      onRuntimeError: (msg) => rendererErrors.push(msg),
    })
    await pageCdp.call('Runtime.enable')
    await pageCdp.call('Log.enable')

    process.stdout.write('[gui-smoke] Waiting for first-launch official runtime extraction & dsh web boot...\n')
    await waitForCondition('official host ready & remote tab rendered', timeoutMs, rendererErrors, async () => {
      const snap = await pageCdp.evaluate(`(async () => {
        if (!window.dshCommunity || typeof window.dshCommunity.hostSnapshot !== 'function') return null;
        const snapshot = await window.dshCommunity.hostSnapshot();
        const remoteBtn = document.querySelector('button[data-go="remote"]');
        return { phase: snapshot?.phase ?? null, hasRemoteBtn: remoteBtn !== null };
      })()`)
      if (!snap || snap.phase !== 'ready' || !snap.hasRemoteBtn) return undefined
      const targetsRes = await fetch(`${debugOrigin}/json/list`, { signal: AbortSignal.timeout(5_000) })
      if (!targetsRes.ok) return undefined
      const targets = await targetsRes.json()
      const foundOrigin = findOfficialWebOrigin(targets)
      if (!foundOrigin) return undefined
      officialOrigin = foundOrigin
      return snap
    })

    process.stdout.write(`[gui-smoke] Official web ready at ${officialOrigin}; clicking Remote tab...\n`)
    await pageCdp.evaluate(`(() => {
      const btn = document.querySelector('button[data-go="remote"]');
      if (!btn) throw new Error('Missing remote navigation button');
      btn.click();
      return true;
    })()`)

    await waitForCondition('Remote Control page initial render', 20_000, rendererErrors, async () => {
      return pageCdp.evaluate(`(() => {
        const startBtn = document.getElementById('remote-start');
        const text = document.body?.innerText ?? '';
        return Boolean(
          startBtn
          && document.title.includes('远程控制')
          && text.includes('远程控制与手机配对')
          && text.includes('DEEPSEEK_API_KEY 已配置')
          && text.includes('已停止')
        );
      })()`)
    })

    process.stdout.write('[gui-smoke] Verifying inline input validation rejection...\n')
    await pageCdp.evaluate(`(() => {
      const relay = document.getElementById('remote-relay');
      if (!relay) throw new Error('Missing #remote-relay');
      relay.value = 'http://invalid-relay.example';
      document.getElementById('remote-start')?.click();
      return true;
    })()`)

    await waitForCondition('Invalid relay URL validation error', 15_000, rendererErrors, async () => {
      return pageCdp.evaluate(`(() => {
        const text = document.body?.innerText ?? '';
        return text.includes('必须使用 ws:// 或 wss:// 协议');
      })()`)
    })

    process.stdout.write('[gui-smoke] Starting packaged headless Remote Host on 127.0.0.1:0...\n')
    await pageCdp.evaluate(`(() => {
      const sel = document.getElementById('listen-host-select');
      const port = document.getElementById('remote-port');
      const relay = document.getElementById('remote-relay');
      if (!sel || !port || !relay) throw new Error('Missing remote form controls');
      sel.value = '127.0.0.1';
      sel.dispatchEvent(new Event('change'));
      port.value = '0';
      relay.value = '';
      document.getElementById('remote-start')?.click();
      return true;
    })()`)

    const firstPairing = await waitForCondition('Packaged Remote Host running + SVG QR rendered', 45_000, rendererErrors, async () => {
      return pageCdp.evaluate(`(() => {
        const text = document.body?.innerText ?? '';
        if (!text.includes('运行中（Desktop 托管）')) return null;
        const svg = document.querySelector('.qr-wrap svg');
        const linkTpl = document.getElementById('copy-deeplink');
        const jsonTpl = document.getElementById('copy-pairing-json');
        if (!svg || !linkTpl || !jsonTpl) return null;
        const deepLink = ('content' in linkTpl ? linkTpl.content.textContent : linkTpl.textContent)?.trim() ?? '';
        const pairingJson = ('content' in jsonTpl ? jsonTpl.content.textContent : jsonTpl.textContent)?.trim() ?? '';
        const shapeCount = svg.querySelectorAll('path, rect').length;
        if (!deepLink || shapeCount === 0) return null;
        return { qrOuterHtml: svg.outerHTML, shapeCount, deepLink, pairingJson, text };
      })()`)
    })

    if (!firstPairing.qrOuterHtml.startsWith('<svg') || firstPairing.shapeCount <= 0) {
      throw new Error('Rendered QR element is missing SVG geometry')
    }
    const firstDesc = validateRemotePairingDeepLink(firstPairing.deepLink, firstPairing.pairingJson)
    firstRemoteEndpointUrl = firstDesc.endpointUrl
    await waitForTcpReachable(firstRemoteEndpointUrl, 10_000)
    process.stdout.write(`[gui-smoke] Remote Host listening & reachable at ${firstRemoteEndpointUrl} (fp=${firstDesc.hostFingerprint})\n`)

    process.stdout.write('[gui-smoke] Rotating pairing QR code...\n')
    await pageCdp.evaluate(`(() => {
      const btn = document.getElementById('remote-new-pairing');
      if (!btn) throw new Error('Missing #remote-new-pairing');
      btn.click();
      return true;
    })()`)

    const rotatedPairing = await waitForCondition('Rotated pairing deep link', 20_000, rendererErrors, async () => {
      const res = await pageCdp.evaluate(`(() => {
        const linkTpl = document.getElementById('copy-deeplink');
        const jsonTpl = document.getElementById('copy-pairing-json');
        if (!linkTpl || !jsonTpl) return null;
        const deepLink = ('content' in linkTpl ? linkTpl.content.textContent : linkTpl.textContent)?.trim() ?? '';
        const pairingJson = ('content' in jsonTpl ? jsonTpl.content.textContent : jsonTpl.textContent)?.trim() ?? '';
        return { deepLink, pairingJson };
      })()`)
      if (!res || !res.deepLink || res.deepLink === firstPairing.deepLink) return null
      return res
    })

    const rotatedDesc = validateRemotePairingDeepLink(rotatedPairing.deepLink, rotatedPairing.pairingJson)
    if (rotatedDesc.bootstrapToken === firstDesc.bootstrapToken) {
      throw new Error('Rotated pairing kept identical bootstrapToken')
    }

    process.stdout.write('[gui-smoke] Stopping Remote Host from UI...\n')
    await pageCdp.evaluate(`(() => {
      const btn = document.getElementById('remote-stop');
      if (!btn) throw new Error('Missing #remote-stop');
      btn.click();
      return true;
    })()`)

    await waitForCondition('Remote Host stopped in UI', 20_000, rendererErrors, async () => {
      return pageCdp.evaluate(`(() => {
        const text = document.body?.innerText ?? '';
        const linkTpl = document.getElementById('copy-deeplink');
        return text.includes('已停止') && linkTpl === null;
      })()`)
    })
    await assertTcpRefused(firstRemoteEndpointUrl, 10_000)

    process.stdout.write('[gui-smoke] Navigating Settings (persisting hideToTray=false) & Diagnostics tabs...\n')
    await pageCdp.evaluate(`(() => {
      document.querySelector('button[data-go="settings"]')?.click();
      return true;
    })()`)
    await waitForCondition('Settings page rendered', 15_000, rendererErrors, async () => {
      return pageCdp.evaluate(`(() => {
        const text = document.body?.innerText ?? '';
        const cb = document.getElementById('hideToTray');
        return text.includes('Desktop 设置') && cb !== null;
      })()`)
    })

    await pageCdp.evaluate(`(() => {
      const cb = document.getElementById('hideToTray');
      if (!cb) throw new Error('Missing #hideToTray');
      cb.checked = false;
      document.getElementById('save')?.click();
      return true;
    })()`)
    await waitForCondition('Settings persisted hideToTray=false', 15_000, rendererErrors, async () => {
      return pageCdp.evaluate(`(() => {
        const cb = document.getElementById('hideToTray');
        return cb !== null && cb.checked === false;
      })()`)
    })

    await pageCdp.evaluate(`(() => {
      document.querySelector('button[data-go="diagnostics"]')?.click();
      return true;
    })()`)
    await waitForCondition('Diagnostics page rendered', 15_000, rendererErrors, async () => {
      return pageCdp.evaluate(`(() => document.body?.innerText?.includes('Host 诊断') === true)()`)
    })

    if (rendererErrors.length > 0) {
      throw new Error(`Renderer security/runtime errors observed:\n${rendererErrors.join('\n')}`)
    }

    process.stdout.write('[gui-smoke] Closing Electron window cleanly (hideToTray=false -> before-quit)...\n')
    await browserCdp.call('Browser.close').catch(() => {})
    pageCdp.close()
    pageCdp = undefined
    browserCdp.close()
    browserCdp = undefined

    let exitResult = await raceWithTimeout(exitPromise, 8_000, { timedOut: true })
    if (exitResult.timedOut) {
      process.stdout.write('[gui-smoke] Browser.close did not exit within 8s; sending SIGTERM...\n')
      killProcessTree(child, 'SIGTERM')
      exitResult = await raceWithTimeout(exitPromise, 10_000, { timedOut: true })
    }
    if (exitResult.timedOut) {
      killProcessTree(child, 'SIGKILL', { forceGroup: true })
      await raceWithTimeout(exitPromise, 3_000, { timedOut: true })
      throw new Error('Electron AppImage did not exit cleanly after Browser.close + SIGTERM')
    }
    if (exitResult.code !== 0) {
      throw new Error(`Electron AppImage exited non-zero: code=${String(exitResult.code)}, signal=${String(exitResult.signal)}`)
    }

    cleanExit = true
    await assertTcpRefused(officialOrigin, 10_000)
    process.stdout.write('[gui-smoke] PASS: Packaged AppImage Electron GUI + Remote Host + clean teardown verified.\n')
  } catch (error) {
    process.stderr.write(`[gui-smoke] FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    if (stderrLines.length > 0) {
      process.stderr.write(`--- Electron stderr tail ---\n${stderrLines.join('')}\n`)
    }
    if (stdoutLines.length > 0) {
      process.stderr.write(`--- Electron stdout tail ---\n${stdoutLines.join('')}\n`)
    }
    if (error && typeof error === 'object') {
      Object.assign(error, { loggedBySmoke: true })
    }
    throw error
  } finally {
    pageCdp?.close()
    browserCdp?.close()
    killProcessTree(child, 'SIGKILL', { forceGroup: !cleanExit })
    child.stdout?.destroy()
    child.stderr?.destroy()
    if (child.exitCode === null && child.signalCode === null) {
      await raceWithTimeout(exitPromise, 3_000, { timedOut: true })
    }
    rmSync(sandboxRoot, { recursive: true, force: true })
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntrypoint) {
  const args = parseSmokeArgs(process.argv.slice(2))
  runAppImageGuiSmoke(args).catch((error) => {
    if (!error || typeof error !== 'object' || !('loggedBySmoke' in error)) {
      process.stderr.write(`[gui-smoke] FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    }
    process.exitCode = 1
  })
}
