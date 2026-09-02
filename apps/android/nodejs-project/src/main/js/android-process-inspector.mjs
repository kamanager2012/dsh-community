import {
  readFileSync,
  readdirSync,
} from 'node:fs'

function quiescent(state) {
  return typeof state === 'string' && /^[ZXx]$/u.test(state)
}

export function parseAndroidProcStat(text) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open <= 0 || close <= open) return undefined

  const pid = Number(text.slice(0, open).trim())
  const rest = text.slice(close + 2).trim().split(/\s+/u)
  const state = rest[0] ?? ''
  const parentPid = Number(rest[1])
  const processGroupId = Number(rest[2])
  const sessionId = Number(rest[3])
  const ttyDevice = Number(rest[4])
  const foregroundGroupId = Number(rest[5])
  const started = rest[19]

  if (![pid, parentPid, processGroupId, sessionId, ttyDevice, foregroundGroupId]
    .every(Number.isSafeInteger)
    || state.length !== 1
    || started === undefined) return undefined

  return {
    pid,
    parentPid,
    processGroupId,
    sessionId,
    state,
    ttyDevice,
    foregroundGroupId,
    started,
  }
}

function processTree(rows, rootPid) {
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const root = byPid.get(rootPid)
  if (root === undefined) return []

  const byParent = new Map()
  for (const row of rows) {
    const children = byParent.get(row.parentPid) ?? []
    children.push(row)
    byParent.set(row.parentPid, children)
  }

  const visited = new Set()
  const result = []
  const visit = (row) => {
    if (visited.has(row.pid)) return
    visited.add(row.pid)
    for (const child of byParent.get(row.pid) ?? []) visit(child)
    result.push({ pid: row.pid, started: row.started })
  }
  visit(root)
  return result
}

export class AndroidProcessSnapshot {
  constructor(rows) {
    this.rows = rows
    this.byPid = new Map(rows.map(row => [row.pid, row]))
  }

  tree(rootPid) {
    return processTree(this.rows, rootPid)
  }

  session(sessionId) {
    return this.rows.flatMap(row =>
      row.sessionId === sessionId ? [{ pid: row.pid, started: row.started }] : [])
  }

  alive(identity) {
    const row = this.byPid.get(identity.pid)
    return row?.started === identity.started && !quiescent(row.state)
  }

  row(pid) {
    return this.byPid.get(pid)
  }
}

const DEFAULT_INTERNALS = {
  readFile(path) {
    return readFileSync(path, 'utf8')
  },
  readDir(path) {
    return readdirSync(path)
  },
  kill(pid, signal) {
    process.kill(pid, signal)
  },
}

export class AndroidProcessInspector {
  constructor(internals = DEFAULT_INTERNALS) {
    this.internals = internals
  }

  readStat(pid) {
    try {
      return parseAndroidProcStat(this.internals.readFile(`/proc/${pid}/stat`))
    } catch {
      return undefined
    }
  }

  snapshot() {
    let entries
    try {
      entries = this.internals.readDir('/proc')
    } catch {
      return new AndroidProcessSnapshot([])
    }

    const rows = []
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue
      const row = this.readStat(Number(entry))
      if (row !== undefined) rows.push(row)
    }
    return new AndroidProcessSnapshot(rows)
  }

  rootIdentity(pid) {
    const row = this.readStat(pid)
    return row === undefined ? undefined : {
      identity: { pid: row.pid, started: row.started },
      sessionId: row.sessionId,
    }
  }

  foregroundPgid(shellPid) {
    const value = this.readStat(shellPid)?.foregroundGroupId
    return Number.isSafeInteger(value) && value > 1 ? value : undefined
  }

  isStdinWaiting(_processGroupId, _shellPid) {
    // Android app sandboxes may deny /proc/<pid>/syscall or /proc/<pid>/mem.
    // The public subprocess seam permits a provider to return false when it
    // cannot PROVE stdin wait (the official E2B provider does the same).
    // terminal-bash then relies on its independent prompt/silence evidence.
    return false
  }

  isAlive(identity) {
    const row = this.readStat(identity.pid)
    return row?.started === identity.started && !quiescent(row.state)
  }

  signalGroup(processGroupId, signal) {
    if (!Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
      throw new Error(`android-subprocess: unsafe process group ${String(processGroupId)}`)
    }
    this.internals.kill(-processGroupId, signal)
  }

  signalProcess(identity, signal) {
    if (!this.isAlive(identity)) return
    this.internals.kill(identity.pid, signal)
  }
}
