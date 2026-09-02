import { readFileSync, readdirSync } from 'node:fs'

const QUIESCENT_STATE = /^[ZXx]$/u

const DEFAULT_INTERNALS = {
  readFile: path => readFileSync(path, 'utf8'),
  readDir: path => readdirSync(path),
  kill: (pid, signal) => process.kill(pid, signal),
}

export function parseAndroidProcStat(text) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open <= 0 || close <= open) return undefined

  const pid = Number(text.slice(0, open).trim())
  const fields = text.slice(close + 2).trim().split(/\s+/u)
  const state = fields[0] ?? ''
  const parentPid = Number(fields[1])
  const processGroupId = Number(fields[2])
  const sessionId = Number(fields[3])
  const ttyDevice = Number(fields[4])
  const foregroundProcessGroupId = Number(fields[5])
  const started = fields[19]

  if (
    ![pid, parentPid, processGroupId, sessionId, ttyDevice, foregroundProcessGroupId]
      .every(Number.isSafeInteger)
    || state.length !== 1
    || started === undefined
  ) return undefined

  return {
    pid,
    parentPid,
    processGroupId,
    sessionId,
    state,
    ttyDevice,
    foregroundProcessGroupId,
    started,
  }
}

function readStat(internals, pid) {
  try {
    return parseAndroidProcStat(internals.readFile(`/proc/${pid}/stat`))
  } catch {
    return undefined
  }
}

function numericProcEntries(internals) {
  try {
    return internals.readDir('/proc')
      .filter(entry => /^\d+$/u.test(entry))
      .map(Number)
  } catch {
    return []
  }
}

function isRunning(row) {
  return row !== undefined && !QUIESCENT_STATE.test(row.state)
}

function treeFromRows(rows, rootPid) {
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
  const visit = row => {
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
    return treeFromRows(this.rows, rootPid)
  }

  session(sessionId) {
    return this.rows
      .filter(row => row.sessionId === sessionId)
      .map(row => ({ pid: row.pid, started: row.started }))
  }

  alive(identity) {
    const row = this.byPid.get(identity.pid)
    return row?.started === identity.started && isRunning(row)
  }
}

export class AndroidProcessInspector {
  constructor(internals = DEFAULT_INTERNALS) {
    this.internals = internals
  }

  foregroundPgid(shellPid) {
    const value = readStat(this.internals, shellPid)?.foregroundProcessGroupId
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }

  // Android intentionally does not inspect /proc/<pid>/mem or task syscalls.
  // The official terminal consumer supports providers that cannot prove stdin wait
  // and falls back to prompt ownership / inferred-idle readiness.
  isStdinWaiting() {
    return false
  }

  snapshot() {
    const rows = numericProcEntries(this.internals).flatMap(pid => {
      const row = readStat(this.internals, pid)
      return row === undefined ? [] : [row]
    })
    return new AndroidProcessSnapshot(rows)
  }

  isAlive(identity) {
    const row = readStat(this.internals, identity.pid)
    return row?.started === identity.started && isRunning(row)
  }

  signalGroup(processGroupId, signal) {
    if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
      throw new Error('android-process-inspector: process group id must be a positive integer')
    }
    this.internals.kill(-processGroupId, signal)
  }

  signalProcess(identity, signal) {
    if (this.isAlive(identity)) this.internals.kill(identity.pid, signal)
  }
}

export function createAndroidProcessInspector(platform = process.platform, internals = DEFAULT_INTERNALS) {
  if (platform !== 'android') {
    throw new Error(`android-process-inspector: expected platform android, observed ${platform}`)
  }
  return new AndroidProcessInspector(internals)
}
