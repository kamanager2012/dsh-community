import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Diagnostics only. Never parsed for agent/tool/session state. */
export function appendHostDiagnostics(logDir: string, chunk: string): void {
  mkdirSync(logDir, { recursive: true })
  appendFileSync(join(logDir, 'host.log'), chunk)
}

export function hostLogPath(logDir: string): string {
  return join(logDir, 'host.log')
}
