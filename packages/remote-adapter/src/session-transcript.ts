import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { extractPreviewTextFromEvent, foldNormalizedSessionEvents } from './session-state-fold.js'
import type { SessionSearchHit } from './protocol.js'

export interface NormalizedTranscriptEvent {
  readonly seq: number
  readonly type: string
  readonly time?: number | undefined
  readonly data?: unknown
}

export interface DecodedOfficialSessionTranscript {
  readonly transcriptPath: string
  readonly mtimeMs: number
  readonly header?: Record<string, unknown> | undefined
  readonly cwd?: string | undefined
  readonly title?: string | undefined
  readonly preview?: string | undefined
  readonly rawEvents: readonly NormalizedTranscriptEvent[]
  readonly normalizedEvents: readonly NormalizedTranscriptEvent[]
}

export interface PaginatedTranscriptResult {
  readonly events: readonly NormalizedTranscriptEvent[]
  readonly hasMore: boolean
  readonly oldestSeq: number | null
  readonly latestSeq: number | null
}

const TRANSCRIPT_FILENAMES = ['session.v4.jsonl.zstd', 'session.jsonl.zstd', 'session.jsonl'] as const
const MAX_TRANSCRIPT_FILE_BYTES = 32 * 1024 * 1024
const MAX_TRANSCRIPT_DECOMPRESSED_BYTES = 64 * 1024 * 1024
const MAX_SEARCH_HITS = 50
const UNSAFE_SESSION_ID_RE = /[/\\\u0000-\u001f\u007f]/u

/** Rejects path-traversal segments, separators, control characters, and empty/overlong IDs. */
export function isSafeSessionId(sessionId: string): boolean {
  if (sessionId.length === 0 || sessionId.length > 256) return false
  if (sessionId !== sessionId.trim()) return false
  if (sessionId === '.' || sessionId === '..' || sessionId.includes('..')) return false
  return !UNSAFE_SESSION_ID_RE.test(sessionId)
}

function isPathInsideRoot(rootDir: string, candidatePath: string): boolean {
  const resolvedRoot = resolve(rootDir)
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`
  const resolvedCandidate = resolve(candidatePath)
  return resolvedCandidate.startsWith(prefix)
}

const ZSTD_MAGIC = 0xFD2FB528
const ZSTD_SKIPPABLE_MASK = 0xFFFFFFF0
const ZSTD_SKIPPABLE_MAGIC = 0x184D2A50

function decodeConcatenatedZstdSync(rawBytes: Buffer, maxOutputBytes: number): string | undefined {
  const chunks: Buffer[] = []
  let totalBytes = 0
  let offset = 0

  while (offset < rawBytes.length) {
    const start = offset
    if (rawBytes.length - offset < 4) {
      return offset > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
    }
    const magic = rawBytes.readUInt32LE(offset)
    if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE_MAGIC) {
      if (rawBytes.length - offset < 8) {
        return offset > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
      }
      const skipSize = rawBytes.readUInt32LE(offset + 4)
      const frameEnd = offset + 8 + skipSize
      if (frameEnd > rawBytes.length) {
        return offset > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
      }
      offset = frameEnd
      continue
    }
    if (magic !== ZSTD_MAGIC) {
      return undefined
    }
    offset += 4
    if (offset >= rawBytes.length) {
      return start > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
    }

    const descriptor = rawBytes.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) return undefined

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (rawBytes.length - offset < remainingHeaderBytes) {
      return start > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
    }
    offset += remainingHeaderBytes

    let completed = true
    for (;;) {
      if (rawBytes.length - offset < 3) {
        completed = false
        break
      }
      const blockHeader = rawBytes.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return undefined
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (rawBytes.length - offset < payloadBytes) {
        completed = false
        break
      }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (!completed) {
      return start > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
    }
    if (checksum) {
      if (rawBytes.length - offset < 4) {
        return start > 0 ? Buffer.concat(chunks).toString('utf8') : undefined
      }
      offset += 4
    }

    const remainingBudget = maxOutputBytes - totalBytes
    if (remainingBudget <= 0) return undefined
    const decoded = zstdDecompressSync(rawBytes.subarray(start, offset), {
      maxOutputLength: remainingBudget,
    })
    chunks.push(decoded)
    totalBytes += decoded.byteLength
  }

  return Buffer.concat(chunks).toString('utf8')
}

function decodeTranscriptText(filePath: string): string | undefined {
  let rawBytes: Buffer
  try {
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_FILE_BYTES) {
      return undefined
    }
    rawBytes = readFileSync(filePath)
  } catch {
    return undefined
  }
  if (rawBytes.byteLength === 0) return ''
  try {
    if (filePath.endsWith('.zstd') || filePath.endsWith('.zst')) {
      return decodeConcatenatedZstdSync(rawBytes, MAX_TRANSCRIPT_DECOMPRESSED_BYTES)
    }
    return rawBytes.toString('utf8')
  } catch {
    return undefined
  }
}

export function findOfficialSessionTranscriptPath(
  sessionsRoot: string,
  sessionId: string,
): string | undefined {
  if (!existsSync(sessionsRoot) || !isSafeSessionId(sessionId)) return undefined

  for (const name of TRANSCRIPT_FILENAMES) {
    const legacyCandidate = join(sessionsRoot, sessionId, name)
    if (isPathInsideRoot(sessionsRoot, legacyCandidate) && existsSync(legacyCandidate)) {
      return legacyCandidate
    }
  }

  let level1
  try {
    level1 = readdirSync(sessionsRoot, { withFileTypes: true })
  } catch {
    return undefined
  }

  for (const entry of level1) {
    if (!entry.isDirectory() || !isSafeSessionId(entry.name)) continue
    const nestedDir = join(sessionsRoot, entry.name, sessionId)
    for (const name of TRANSCRIPT_FILENAMES) {
      const nestedCandidate = join(nestedDir, name)
      if (isPathInsideRoot(sessionsRoot, nestedCandidate) && existsSync(nestedCandidate)) {
        return nestedCandidate
      }
    }
  }
  return undefined
}

export function readDecodedOfficialTranscript(
  transcriptPath: string,
  mtimeMsFallback = 0,
): DecodedOfficialSessionTranscript | undefined {
  const text = decodeTranscriptText(transcriptPath)
  if (text === undefined) return undefined

  let mtimeMs = mtimeMsFallback
  if (mtimeMs <= 0) {
    try {
      mtimeMs = statSync(transcriptPath).mtimeMs
    } catch {
      mtimeMs = 0
    }
  }

  let header: Record<string, unknown> | undefined
  let cwd: string | undefined
  let title: string | undefined
  const rawEvents: NormalizedTranscriptEvent[] = []
  const normalizedEvents: NormalizedTranscriptEvent[] = []

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]?.trim()
    if (!line) continue
    let parsed: Record<string, unknown>
    try {
      const value = JSON.parse(line) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      parsed = value as Record<string, unknown>
    } catch {
      continue
    }

    if (typeof parsed.type !== 'string' || parsed.type === 'session') {
      if (i === 0 || header === undefined || parsed.type === 'session') {
        header = parsed
        const meta = parsed.meta
        if (typeof meta === 'object' && meta !== null && typeof (meta as Record<string, unknown>).cwd === 'string') {
          cwd = (meta as Record<string, unknown>).cwd as string
        } else if (typeof parsed.cwd === 'string' && parsed.cwd.trim().length > 0) {
          cwd = parsed.cwd.trim()
        }
        if (typeof parsed.title === 'string' && parsed.title.trim().length > 0) {
          title = parsed.title.trim()
        }
      }
      continue
    }

    const rawSeq =
      typeof parsed.seq === 'number' && Number.isSafeInteger(parsed.seq) && parsed.seq >= 0
        ? parsed.seq
        : rawEvents.length
    const normalizedSeq = normalizedEvents.length + 1
    const eventTime = typeof parsed.time === 'number' && Number.isFinite(parsed.time) ? parsed.time : undefined
    let payloadData: unknown = parsed.data
    if (payloadData === undefined) {
      const rest: Record<string, unknown> = {}
      let hasExtra = false
      for (const [k, v] of Object.entries(parsed)) {
        if (k === 'seq' || k === 'type' || k === 'time') continue
        rest[k] = v
        hasExtra = true
      }
      if (hasExtra) payloadData = rest
    }
    const rawEvent: NormalizedTranscriptEvent = {
      seq: rawSeq,
      type: parsed.type,
      ...(eventTime !== undefined ? { time: eventTime } : {}),
      ...(payloadData !== undefined ? { data: payloadData } : {}),
    }
    rawEvents.push(rawEvent)
    normalizedEvents.push({
      ...rawEvent,
      seq: normalizedSeq,
    })

    if (parsed.type === 'session/title' && typeof payloadData === 'object' && payloadData !== null) {
      const candidate = (payloadData as Record<string, unknown>).title
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        title = candidate.trim()
      }
    }
  }

  const folded = foldNormalizedSessionEvents(normalizedEvents)
  return {
    transcriptPath,
    mtimeMs,
    ...(header !== undefined ? { header } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...((title ?? folded.title) !== undefined ? { title: title ?? folded.title } : {}),
    ...(folded.preview !== undefined ? { preview: folded.preview } : {}),
    rawEvents,
    normalizedEvents,
  }
}

export function paginateNormalizedTranscriptEvents(
  events: readonly NormalizedTranscriptEvent[],
  options: {
    readonly beforeSeq?: number | undefined
    readonly limit?: number | undefined
    readonly minTurns?: number | undefined
    readonly maxBytes?: number | undefined
  } = {},
): PaginatedTranscriptResult {
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)))
  const minTurns = options.minTurns !== undefined && options.minTurns > 0 ? Math.trunc(options.minTurns) : 0
  const maxBytes = Math.max(4096, Math.trunc(options.maxBytes ?? 44 * 1024))
  const maxTurnWindowExpand = Math.min(200, limit * 4)

  const eligible = options.beforeSeq === undefined
    ? events
    : events.filter((event) => event.seq < options.beforeSeq!)

  if (eligible.length === 0) {
    return {
      events: [],
      hasMore: false,
      oldestSeq: events[0]?.seq ?? null,
      latestSeq: events[events.length - 1]?.seq ?? null,
    }
  }

  let startIndex = Math.max(0, eligible.length - limit)
  if (minTurns > 0 && startIndex > 0) {
    let seenTurnStarts = 0
    for (let i = eligible.length - 1; i >= startIndex; i -= 1) {
      if (eligible[i]?.type === 'turn/start') seenTurnStarts += 1
    }
    const minIndexFloor = Math.max(0, eligible.length - maxTurnWindowExpand)
    while (startIndex > minIndexFloor && seenTurnStarts < minTurns) {
      startIndex -= 1
      if (eligible[startIndex]?.type === 'turn/start') {
        seenTurnStarts += 1
      }
    }
  }

  while (startIndex < eligible.length - 1) {
    const candidate = eligible.slice(startIndex)
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= maxBytes) {
      break
    }
    startIndex += Math.max(1, Math.floor((eligible.length - startIndex) / 4))
  }

  const page = eligible.slice(startIndex)
  return {
    events: page,
    hasMore: startIndex > 0,
    oldestSeq: page[0]?.seq ?? null,
    latestSeq: page[page.length - 1]?.seq ?? null,
  }
}

function searchableTextForEvent(event: NormalizedTranscriptEvent): string | undefined {
  const preview = extractPreviewTextFromEvent(event)
  if (preview !== undefined) return preview
  if (event.type === 'session/title' && typeof event.data === 'object' && event.data !== null) {
    const t = (event.data as Record<string, unknown>).title
    if (typeof t === 'string' && t.trim().length > 0) return t.trim()
  }
  return undefined
}

export function searchSessionCollections(options: {
  readonly query: string
  readonly limit?: number | undefined
  readonly sessionId?: string | undefined
  readonly sources: readonly {
    readonly sessionId: string
    readonly title?: string | undefined
    readonly updatedAt?: string | undefined
    readonly events: readonly NormalizedTranscriptEvent[]
  }[]
}): { readonly hits: SessionSearchHit[]; readonly hasMore: boolean } {
  const needle = options.query.trim().toLowerCase()
  const maxHits = Math.max(1, Math.min(MAX_SEARCH_HITS, Math.trunc(options.limit ?? 20)))
  if (needle.length === 0) {
    return { hits: [], hasMore: false }
  }

  const hits: SessionSearchHit[] = []
  let hasMore = false

  for (const source of options.sources) {
    if (options.sessionId !== undefined && source.sessionId !== options.sessionId) continue
    for (let i = source.events.length - 1; i >= 0; i -= 1) {
      const event = source.events[i]!
      const text = searchableTextForEvent(event)
      if (text === undefined) continue
      const matchIndex = text.toLowerCase().indexOf(needle)
      if (matchIndex < 0) continue

      if (hits.length >= maxHits) {
        hasMore = true
        return { hits, hasMore }
      }

      const start = Math.max(0, matchIndex - 32)
      const end = Math.min(text.length, matchIndex + needle.length + 64)
      const snippet = `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
      hits.push({
        sessionId: source.sessionId,
        ...(source.title !== undefined ? { title: source.title } : {}),
        seq: event.seq,
        type: event.type,
        snippet,
        ...(source.updatedAt !== undefined ? { updatedAt: source.updatedAt } : {}),
      })
    }
  }

  return { hits, hasMore }
}
