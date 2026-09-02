import { createRequire } from 'node:module'
import { AndroidProcessInspector } from './android-process-inspector.mjs'
import { AndroidTerminalHandle } from './android-terminal-handle.mjs'

const TIMEOUT_MS = 7000
const POLL_MS = 25

function fail(message) {
  throw new Error(`android-pty-provider-probe: ${message}`)
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) fail(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}

async function main() {
  if (process.platform !== 'android') {
    fail(`expected process.platform=android, observed ${process.platform}`)
  }

  const nodePtyPath = process.argv[2]
  const cwd = process.argv[3] ?? '/data/local/tmp'
  if (typeof nodePtyPath !== 'string' || !nodePtyPath.startsWith('/')) {
    fail('absolute node-pty package path is required')
  }
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
    fail('absolute cwd is required')
  }

  const require = createRequire(import.meta.url)
  const nodePty = require(nodePtyPath)
  const inspector = new AndroidProcessInspector()
  const terminal = nodePty.spawn('/system/bin/sh', [], {
    name: 'dumb',
    cols: 80,
    rows: 24,
    cwd,
    env: {
      PATH: '/system/bin',
      HOME: cwd,
      TMPDIR: cwd,
    },
  })

  let handle
  let output = ''
  try {
    let root
    await waitUntil(() => {
      root = inspector.rootIdentity(terminal.pid)
      return root !== undefined
    }, 'PTY root identity')

    if (root.sessionId !== terminal.pid) {
      fail(`PTY pid ${terminal.pid} is not its POSIX session leader (sid=${root.sessionId})`)
    }

    handle = new AndroidTerminalHandle(
      terminal,
      inspector,
      1500,
      root.identity,
      root.sessionId,
    )
    handle.output.on('data', chunk => {
      output += chunk.toString('utf8')
    })

    const initialForeground = await handle.inspectForeground()
    if (initialForeground === undefined || initialForeground.processGroupId <= 1) {
      fail('cannot resolve a safe initial foreground process group')
    }
    if (initialForeground.inputWaiting !== false) {
      fail('Android provider must not invent stdin-wait evidence')
    }

    await handle.write("printf 'DSH_PROVIDER_WRITE_OK\\n'\n")
    await waitUntil(() => output.includes('DSH_PROVIDER_WRITE_OK'), 'provider write marker')

    await handle.write("sleep 30\n")
    await new Promise(resolve => setTimeout(resolve, 150))

    const foreground = await handle.inspectForeground()
    if (foreground === undefined || foreground.processGroupId <= 1) {
      fail('cannot resolve foreground process group for signal smoke')
    }
    const signalled = await handle.signalForeground('SIGINT')
    if (signalled !== foreground.processGroupId) {
      fail(`signalForeground returned ${signalled}, expected ${foreground.processGroupId}`)
    }

    await handle.write("printf 'DSH_PROVIDER_AFTER_SIGNAL_OK\\n'\n")
    await waitUntil(
      () => output.includes('DSH_PROVIDER_AFTER_SIGNAL_OK'),
      'post-signal provider write marker',
    )

    await handle.terminate()

    if (inspector.isAlive(root.identity)) {
      fail(`root identity survived terminate: pid=${root.identity.pid}`)
    }
    const observed = inspector.snapshot()
    const liveSessionMembers = observed.session(root.sessionId)
      .filter(member => observed.alive(member))
    if (liveSessionMembers.length !== 0) {
      fail(`session members survived terminate: ${liveSessionMembers.map(x => x.pid).join(',')}`)
    }

    process.stdout.write(
      `ANDROID_PTY_PROVIDER_ADB_SHELL_OK_NOT_APP_UID_ACCEPTANCE pid=${terminal.pid} signalPgid=${signalled}\n`,
    )
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.terminate()
      } catch {
        // Preserve the primary probe error.
      }
    } else {
      try {
        terminal.kill('SIGKILL')
      } catch {
        // Allocation failure cleanup only.
      }
    }
    throw error
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
