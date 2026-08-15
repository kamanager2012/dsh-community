import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Official jsonl persistence lives here under DSH_HOME. Not a Desktop/TUI store. */
export const OFFICIAL_SESSION_DIR = 'sessions'

export const OFFICIAL_SESSION_FILES = ['session.jsonl.zstd', 'session.jsonl'] as const

export interface OfficialSessionRef {
  readonly id: string
  readonly projectKey: string
  readonly transcript: string
  readonly mtimeMs: number
}

export function officialSessionRoot(dshHome: string): string {
  return join(dshHome, OFFICIAL_SESSION_DIR)
}

/**
 * Read-only discovery of official JSONL sessions.
 * Does not decode events or invent a second log format.
 */
export function listOfficialSessions(root: string): OfficialSessionRef[] {
  if (!existsSync(root)) return []
  const found: OfficialSessionRef[] = []
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      const sessionDir = join(projectDir, session.name)
      for (const file of OFFICIAL_SESSION_FILES) {
        const transcript = join(sessionDir, file)
        if (!existsSync(transcript)) continue
        found.push({
          id: session.name,
          projectKey: project.name,
          transcript,
          mtimeMs: statSync(transcript).mtimeMs,
        })
        break
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

export function dumpUsesOfficialSessionRoot(dump: string): boolean {
  return dump.includes("dshHomePath('sessions')") || dump.includes('dshHomePath("sessions")')
}
