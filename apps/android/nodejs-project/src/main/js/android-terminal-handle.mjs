import { Buffer } from 'node:buffer'
import { constants } from 'node:os'
import { PassThrough } from 'node:stream'

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function signalName(number) {
  if (number === undefined || number === 0) return null
  for (const [name, value] of Object.entries(constants.signals)) {
    if (value === number) return name
  }
  return null
}

function memberKey(member) {
  return `${member.pid}:${member.started}`
}

export class AndroidTerminalHandle {
  constructor(terminal, inspector, graceMs) {
    this.terminal = terminal
    this.inspector = inspector
    this.graceMs = graceMs
    this.pid = terminal.pid
    this.output = new PassThrough()
    this.outcome = Promise.withResolvers()
    this.done = this.outcome.promise
    this.exited = false
    this.cleanup = undefined
    this.trackedDescendants = []

    const root = inspector.snapshot().tree(this.pid).find(member => member.pid === this.pid)
    this.rootIdentity = root

    this.dataDisposable = terminal.onData(data => {
      this.output.write(Buffer.from(data, 'utf8'))
    })
    this.exitDisposable = terminal.onExit(({ exitCode, signal }) => {
      if (this.exited) return
      this.exited = true
      this.output.end()
      this.outcome.resolve({
        exitCode: signal === undefined || signal === 0 ? exitCode : null,
        signal: signalName(signal),
      })
    })
  }

  async write(data) {
    if (this.exited) throw new Error('terminal process has exited')
    this.terminal.write(data)
  }

  async inspectForeground() {
    this.captureDescendants(this.inspector.snapshot())
    const processGroupId = this.inspector.foregroundPgid(this.pid)
    if (processGroupId === undefined) return undefined
    return {
      processGroupId,
      inputWaiting: false,
    }
  }

  async signalForeground(signal) {
    const foreground = await this.inspectForeground()
    if (foreground === undefined) {
      throw new Error(`cannot resolve foreground process group for terminal ${this.pid}`)
    }
    if (signal === 'SIGKILL' && foreground.processGroupId === this.pid) {
      throw new Error('refusing to SIGKILL the terminal shell; terminate the terminal session instead')
    }
    this.inspector.signalGroup(foreground.processGroupId, signal)
    return foreground.processGroupId
  }

  terminate() {
    if (this.cleanup !== undefined) return this.cleanup
    const cleanup = this.closeOnce()
    this.cleanup = cleanup
    void cleanup.catch(() => { this.cleanup = undefined })
    return cleanup
  }

  terminateForHostExit() {
    this.forceStopDescendants()
    this.forceStopShell()
    this.forceStopDescendants()
  }

  unionMembers(...groups) {
    const result = []
    const seen = new Set()
    for (const group of groups) {
      for (const member of group) {
        const key = memberKey(member)
        if (seen.has(key)) continue
        seen.add(key)
        result.push(member)
      }
    }
    return result
  }

  survivors(members, snapshot) {
    return members.filter(member => snapshot.alive(member))
  }

  captureDescendants(snapshot) {
    const tree = snapshot.tree(this.pid)
    const root = tree.find(member => member.pid === this.pid)
    const rootVerified = this.rootIdentity !== undefined
      && root !== undefined
      && root.started === this.rootIdentity.started

    const discovered = rootVerified
      ? this.unionMembers(tree, snapshot.session(this.pid))
      : []

    this.trackedDescendants = this.survivors(
      this.unionMembers(this.trackedDescendants, discovered)
        .filter(member => member.pid !== this.pid),
      snapshot,
    )
    return this.trackedDescendants
  }

  signalMembers(members, signal) {
    for (const member of members) {
      try {
        this.inspector.signalProcess(member, signal)
      } catch {
        // Exact start identities fence PID reuse; an already-exited member is success.
      }
    }
  }

  async waitForMembers(members) {
    if (members.length === 0) return []
    const until = Date.now() + this.graceMs
    let survivors = this.survivors(members, this.inspector.snapshot())
    while (survivors.length > 0 && Date.now() < until) {
      await delay(Math.min(25, Math.max(1, until - Date.now())))
      survivors = this.survivors(members, this.inspector.snapshot())
    }
    return survivors
  }

  async stopDescendants() {
    const captured = this.captureDescendants(this.inspector.snapshot())
    this.signalMembers(captured, 'SIGTERM')
    const afterTerm = await this.waitForMembers(captured)
    const discovered = this.captureDescendants(this.inspector.snapshot())
    const killSet = this.unionMembers(afterTerm, discovered)
    this.signalMembers(killSet, 'SIGKILL')
    const afterKill = await this.waitForMembers(killSet)
    return this.survivors(
      this.unionMembers(afterKill, this.captureDescendants(this.inspector.snapshot())),
      this.inspector.snapshot(),
    )
  }

  async stopShell() {
    if (!this.exited) {
      try {
        this.terminal.kill('SIGTERM')
      } catch {
        // The exit event is authoritative.
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!this.exited) {
      try {
        this.terminal.kill('SIGKILL')
      } catch {
        // The exit event is authoritative.
      }
      await Promise.race([this.done.then(() => undefined), delay(this.graceMs)])
    }
    if (!this.exited) throw new Error(`android terminal cleanup failed; surviving pid: ${this.pid}`)
  }

  forceStopShell() {
    if (this.exited) return
    if (this.rootIdentity !== undefined) {
      try {
        this.inspector.signalProcess(this.rootIdentity, 'SIGKILL')
        return
      } catch {
        // Fall through to the PTY backend.
      }
    }
    try {
      this.terminal.kill('SIGKILL')
    } catch {
      // Process exit is already success during host shutdown.
    }
  }

  forceStopDescendants() {
    let members = this.trackedDescendants
    try {
      members = this.captureDescendants(this.inspector.snapshot())
    } catch {
      // Preserve previously captured exact identities if /proc is unavailable.
    }
    this.signalMembers(members, 'SIGKILL')
  }

  async closeOnce() {
    let survivors = await this.stopDescendants()
    if (survivors.length > 0) {
      throw new Error(
        `android terminal cleanup failed; surviving pids: ${survivors.map(member => member.pid).join(', ')}`,
      )
    }

    await this.stopShell()

    survivors = await this.stopDescendants()
    if (survivors.length > 0) {
      throw new Error(
        `android terminal cleanup failed after shell exit; surviving pids: ${survivors.map(member => member.pid).join(', ')}`,
      )
    }

    this.dataDisposable.dispose()
    this.exitDisposable.dispose()
  }
}
