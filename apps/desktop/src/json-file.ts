import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.${String(process.pid)}.${randomBytes(6).toString('hex')}.tmp`
  const payload = `${JSON.stringify(value, null, 2)}\n`
  try {
    writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(tmpPath, path)
  } catch (error) {
    rmSync(tmpPath, { force: true })
    throw error
  }
}
