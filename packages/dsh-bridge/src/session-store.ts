import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Official jsonl persistence lives here under DSH_HOME. Not a Desktop/TUI store. */
export const OFFICIAL_SESSION_DIR = 'sessions'

export const OFFICIAL_SESSION_FILES = ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.jsonl'] as const

export interface OfficialSessionRef {
  readonly id: string
  readonly projectKey: string
  readonly transcript: string
  readonly mtimeMs: number
}

export interface OfficialSessionSummary {
  readonly title?: string | undefined
  readonly cwd?: string | undefined
  readonly preview?: string | undefined
  readonly model?: string | undefined
  readonly turnCount?: number | undefined
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
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let sessions
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const sessionDir = join(projectDir, session.name)
      for (const file of OFFICIAL_SESSION_FILES) {
        const transcript = join(sessionDir, file)
        if (!existsSync(transcript)) continue
        let mtimeMs: number
        try {
          mtimeMs = statSync(transcript).mtimeMs
        } catch {
          continue
        }
        found.push({
          id: session.name,
          projectKey: project.name,
          transcript,
          mtimeMs,
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

/** Display-only. Does not decode the official transcript. */
export function formatOfficialSessionMtime(mtimeMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return '—'
  return `${new Date(mtimeMs).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

const MAX_PEEK_BYTES = 16 * 1024 * 1024
const MAX_PEEK_DECOMPRESSED_BYTES = 32 * 1024 * 1024
const ZSTD_MAGIC = 0xFD2FB528

function decodeMultiFrameZstd(raw: Buffer, maxOutputBytes: number): string | undefined {
  const chunks: Buffer[] = []
  let totalBytes = 0
  let offset = 0
  while (offset < raw.length) {
    const start = offset
    if (raw.length - offset < 4) return offset > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
    const magic = raw.readUInt32LE(offset)
    if ((magic & 0xFFFFFFF0) === 0x184D2A50) {
      if (raw.length - offset < 8) return offset > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
      const skipSize = raw.readUInt32LE(offset + 4)
      if (offset + 8 + skipSize > raw.length) return offset > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
      offset += 8 + skipSize
      continue
    }
    if (magic !== ZSTD_MAGIC) return undefined
    offset += 4
    if (offset >= raw.length) return start > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
    const descriptor = raw.readUInt8(offset++)
    if ((descriptor & 0x18) !== 0) return undefined
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictFlag = descriptor & 0x03
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const fcsBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remHdr = (singleSegment ? 0 : 1) + dictBytes + fcsBytes
    if (raw.length - offset < remHdr) return start > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
    offset += remHdr
    let completed = true
    for (;;) {
      if (raw.length - offset < 3) {
        completed = false
        break
      }
      const bh = raw.readUIntLE(offset, 3)
      offset += 3
      const last = (bh & 1) !== 0
      const btype = (bh >>> 1) & 3
      if (btype === 3) return undefined
      const pBytes = btype === 1 ? 1 : bh >>> 3
      if (raw.length - offset < pBytes) {
        completed = false
        break
      }
      offset += pBytes
      if (last) break
    }
    if (!completed) return start > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
    if (checksum) {
      if (raw.length - offset < 4) return start > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
      offset += 4
    }
    const rem = maxOutputBytes - totalBytes
    if (rem <= 0) return undefined
    const decoded = zstdDecompressSync(raw.subarray(start, offset), { maxOutputLength: rem })
    chunks.push(decoded)
    totalBytes += decoded.byteLength
  }
  return Buffer.concat(chunks).toString('utf8')
}

function extractSummaryText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const clean = content.trim().replace(/\s+/gu, ' ')
    return clean.length > 120 ? `${clean.slice(0, 120)}…` : clean || undefined
  }
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as Record<string, unknown>
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text.trim())
    }
  }
  if (parts.length === 0) return undefined
  const merged = parts.join(' ').replace(/\s+/gu, ' ').trim()
  return merged.length > 120 ? `${merged.slice(0, 120)}…` : merged
}

/**
 * Pure read-only inspection of an official session transcript (`.jsonl`, `.jsonl.zstd`, `.v4.jsonl.zstd`)
 * for UI titles, previews, cwd, and model badges without creating any sidecar state files.
 */
export function peekOfficialSessionSummary(transcriptPath: string): OfficialSessionSummary | undefined {
  let raw: Buffer
  try {
    const st = statSync(transcriptPath)
    if (!st.isFile() || st.size === 0 || st.size > MAX_PEEK_BYTES) return undefined
    raw = readFileSync(transcriptPath)
  } catch {
    return undefined
  }
  let text: string | undefined
  try {
    text = (transcriptPath.endsWith('.zstd') || transcriptPath.endsWith('.zst'))
      ? decodeMultiFrameZstd(raw, MAX_PEEK_DECOMPRESSED_BYTES)
      : raw.toString('utf8')
  } catch {
    return undefined
  }
  if (text === undefined) return undefined

  let title: string | undefined
  let cwd: string | undefined
  let preview: string | undefined
  let model: string | undefined
  let turnCount = 0

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim()
    if (!line || !line.startsWith('{')) continue
    let parsed: Record<string, unknown>
    try {
      const val = JSON.parse(line) as unknown
      if (typeof val !== 'object' || val === null || Array.isArray(val)) continue
      parsed = val as Record<string, unknown>
    } catch {
      continue
    }

    if (typeof parsed.type !== 'string' || parsed.type === 'session') {
      const meta = (typeof parsed.meta === 'object' && parsed.meta !== null)
        ? (parsed.meta as Record<string, unknown>)
        : parsed
      if (typeof meta.cwd === 'string' && meta.cwd.trim() !== '') cwd = meta.cwd.trim()
      if (typeof parsed.title === 'string' && parsed.title.trim() !== '') title = parsed.title.trim()
      continue
    }

    const data = (typeof parsed.data === 'object' && parsed.data !== null)
      ? (parsed.data as Record<string, unknown>)
      : parsed

    if (parsed.type === 'session/title' && typeof data.title === 'string' && data.title.trim() !== '') {
      title = data.title.trim()
    } else if (parsed.type === 'turn/start') {
      turnCount += 1
    } else if (
      (parsed.type === 'session.model' || parsed.type === 'session/model' || parsed.type === 'model.selected') &&
      typeof data.model === 'string' &&
      data.model !== ''
    ) {
      model = data.model
    } else if (parsed.type === 'user/message' || parsed.type === 'assistant/message') {
      const msg = (typeof data.message === 'object' && data.message !== null)
        ? (data.message as Record<string, unknown>)
        : data
      const src = msg.source
      if (
        parsed.type === 'user/message' &&
        typeof src === 'object' &&
        src !== null &&
        (src as Record<string, unknown>).kind !== undefined &&
        (src as Record<string, unknown>).kind !== 'user'
      ) {
        continue
      }
      const nextPreview = extractSummaryText(msg.content)
      if (nextPreview !== undefined) preview = nextPreview
    }
  }

  if (title === undefined && cwd === undefined && preview === undefined && model === undefined && turnCount === 0) {
    return undefined
  }
  return {
    ...(title !== undefined ? { title } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(preview !== undefined ? { preview } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(turnCount > 0 ? { turnCount } : {}),
  }
}
