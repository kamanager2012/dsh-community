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

export class AndroidTerminalHandle {
  constructor(terminal, inspector, graceMs, rootIdentity, sessionId) {
    this.terminal = terminal
    this.inspector = inspector
    this.graceMs = graceMs
    this.pid = terminal.pid
    this.rootIdentity = rootIdentity
    this.sessionId = sessionId
    this.output = new PassThrough()
    this.exited = false
    this.cleanup = undefined
    this.trackedMembers = []
    this.outcome = Promise.withResolvers()
    this.done = this.outcome.promise

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
    if (this.exited) throw new Error('android-subprocess: terminal process has exited')
    this.terminal.write(data)
  }

  async inspectForeground() {
    this.captureMembers(this.inspector.snapshot())
    const processGroupId = this.inspector.foregroundPgid(this.pid)
    if (processGroupId === undefined) return undefined
    return {
      processGroupId,
      inputWaiting: this.inspector.isStdinWaiting(processGroupId, this.pid),
    }
  }

  async signalForeground(signal) {
    const foreground = await this.inspectForeground()
    if (foreground === undefined) {
      throw new Error(`android-subprocess: cannot resolve foreground process group for terminal ${this.pid}`)
    }
    if (signal === 'SIGKILL' && foreground.processGroupId === this.pid) {
      throw new Error('android-subprocess: refusing to SIGKILL the terminal shell; terminate the terminal session instead')
    }
    this.inspector.signalGroup(foreground.processGroupId, signal)
    return foreground.processGroupId
  }

  terminate() {
    if (this.cleanup !== undefined) return this.cleanup
    this.cleanup = this.closeOnce().catch(error => {
      this.cleanup = undefined
      throw error
    })
    return this.cleanup
  }

  terminateForHostExit() {
    let members = this.trackedMembers
    try {
      members = this.captureMembers(this.inspector.snapshot())
    } catch {
      // Keep the last identity-fenced set when /proc is unavailable at exit.
    }
    this.signalMembers(members, 'SIGKILL')
    try {
      this.inspector.signalProcess(this.rootIdentity, 'SIGKILL')
    } catch {
      // Host exit is best-effort after the identity fence.
    }
  }

  captureMembers(observed) {
    const rootRow = observed.row(this.pid)
    const rootVerified = rootRow !== undefined
      && rootRow.started === this.rootIdentity.started
      && rootRow.sessionId === this.sessionId

    const candidates = rootVerified
      ? [...observed.tree(this.pid), ...observed.session(this.sessionId)]
      : []

    const merged = new Map(this.trackedMembers.map(member => [
      `${member.pid}:${member.started}`,
      member,
    ]))
    for (const member of candidates) {
      if (member.pid === this.pid) continue
      merged.set(`${member.pid}:${member.started}`, member)
    }
    this.trackedMembers = [...merged.values()].filter(member => observed.alive(member))
    return this.trackedMembers
  }

  signalMembers(members, signal) {
    for (const member of members) {
      try {
        this.inspector.signalProcess(member, signal)
      } catch {
        // A same-tick exit is success; every signal is PID-reuse fenced.
      }
    }
  }

  survivors(members) {
    const observed = this.inspector.snapshot()
    return members.filter(member => observed.alive(member))
  }

  async waitForMembers(members) {
    const deadline = Date.now() + this.graceMs
    let live = this.survivors(members)
    while (live.length > 0 && Date.now() < deadline) {
      await delay(Math.min(25, Math.max(1, deadline - Date.now())))
      live = this.survivors(members)
    }
    return live
  }

  async stopMembers() {
    const captured = this.captureMembers(this.inspector.snapshot())
    this.signalMembers(captured, 'SIGTERM')
    let live = await this.waitForMembers(captured)

    const observed = this.inspector.snapshot()
    const rescanned = this.captureMembers(observed)
    const union = new Map([...live, ...rescanned].map(member => [
      `${member.pid}:${member.started}`,
      member,
    ]))
    live = [...union.values()]
    this.signalMembers(live, 'SIGKILL')
    return await this.waitForMembers(live)
  }

  async waitForRootGone() {
    const deadline = Date.now() + this.graceMs
    while (this.inspector.isAlive(this.rootIdentity) && Date.now() < deadline) {
      await delay(Math.min(25, Math.max(1, deadline - Date.now())))
    }
    return !this.inspector.isAlive(this.rootIdentity)
  }

  settleIfRootGone() {
    if (this.exited || this.inspector.isAlive(this.rootIdentity)) return
    this.exited = true
    this.output.end()
    this.outcome.resolve({ exitCode: null, signal: null })
  }

  async stopRoot() {
    if (!this.inspector.isAlive(this.rootIdentity)) {
      this.settleIfRootGone()
      return
    }

    this.inspector.signalProcess(this.rootIdentity, 'SIGTERM')
    await Promise.race([this.done.then(() => undefined), this.waitForRootGone()])
    if (!this.inspector.isAlive(this.rootIdentity)) {
      this.settleIfRootGone()
      return
    }

    this.inspector.signalProcess(this.rootIdentity, 'SIGKILL')
    await Promise.race([this.done.then(() => undefined), this.waitForRootGone()])
    if (this.inspector.isAlive(this.rootIdentity)) {
      throw new Error(`android-subprocess: terminal cleanup failed; surviving pid: ${this.pid}`)
    }
    this.settleIfRootGone()
  }

  async closeOnce() {
    let survivors = await this.stopMembers()
    if (survivors.length > 0) {
      throw new Error(
        `android-subprocess: terminal cleanup failed; surviving pids: ${survivors.map(x => x.pid).join(', ')}`,
      )
    }

    await this.stopRoot()

    survivors = await this.stopMembers()
    if (survivors.length > 0) {
      throw new Error(
        `android-subprocess: terminal cleanup failed after root exit; surviving pids: ${survivors.map(x => x.pid).join(', ')}`,
      )
    }

    this.dataDisposable.dispose()
    this.exitDisposable.dispose()
  }
}
