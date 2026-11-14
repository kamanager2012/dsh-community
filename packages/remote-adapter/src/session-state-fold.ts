import type {
  ModelSelectionParams,
  PendingApprovalSnapshot,
  PendingQuestionSnapshot,
  SessionLiveStateSnapshot,
  SessionUsageSnapshot,
  TodoItemSnapshot,
} from './protocol.js'
import { sanitizeLoneSurrogates, truncateByCodePoints } from './unicode.js'

export const MAX_APPROVAL_ARGS_BYTES = 12 * 1024
export const MAX_APPROVAL_TEXT_BYTES = 2 * 1024
export const MAX_ATTACH_LIVESTATE_BYTES = 28 * 1024
export const MAX_ATTACH_RESPONSE_BYTES = 48 * 1024

function safeJsonStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function jsonByteLength(value: unknown): number {
  const serialized = safeJsonStringify(value)
  return serialized === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(serialized, 'utf8')
}

function truncateUtf8ToBytes(input: string, maxBytes: number): string {
  const clean = sanitizeLoneSurrogates(input)
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(clean, 'utf8') <= maxBytes) return clean
  let usedBytes = 0
  let out = ''
  for (const cp of clean) {
    const step = Buffer.byteLength(cp, 'utf8')
    if (usedBytes + step > maxBytes) break
    out += cp
    usedBytes += step
  }
  return out
}

function shrinkJsonValue(
  value: unknown,
  maxStringBytes: number,
  maxKeys: number,
  maxArrayItems: number,
  depth: number,
): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    const clean = sanitizeLoneSurrogates(value)
    const bytes = Buffer.byteLength(clean, 'utf8')
    if (bytes <= maxStringBytes) return clean
    const suffix = `… [truncated, ${bytes} B total]`
    const keepBytes = Math.max(0, maxStringBytes - Buffer.byteLength(suffix, 'utf8'))
    return `${truncateUtf8ToBytes(clean, keepBytes)}${suffix}`
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return Number.isNaN(value) ? String(value) : value
  }
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
    return shrinkJsonValue(String(value), maxStringBytes, maxKeys, maxArrayItems, depth)
  }
  if (depth >= 4) {
    return '[truncated nested value]'
  }
  if (Array.isArray(value)) {
    const slice = value.slice(0, maxArrayItems).map((item) =>
      shrinkJsonValue(item, Math.max(64, Math.floor(maxStringBytes / 2)), maxKeys, maxArrayItems, depth + 1),
    )
    if (value.length > maxArrayItems) {
      slice.push(`… (+${value.length - maxArrayItems} items omitted)`)
    }
    return slice
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    // Preserve compact metadata keys (e.g. file_path, command, cwd) before oversized payload keys.
    const ordered = [...entries].sort(([, a], [, b]) => {
      const aSmall = a === null || typeof a === 'boolean' || typeof a === 'number' || (typeof a === 'string' && a.length <= 256)
      const bSmall = b === null || typeof b === 'boolean' || typeof b === 'number' || (typeof b === 'string' && b.length <= 256)
      return Number(bSmall) - Number(aSmall)
    })
    const out: Record<string, unknown> = {}
    let added = 0
    for (const [k, v] of ordered) {
      if (added >= maxKeys) break
      if (v === undefined) continue
      out[k] = shrinkJsonValue(v, maxStringBytes, Math.max(4, Math.floor(maxKeys / 2)), Math.max(4, Math.floor(maxArrayItems / 2)), depth + 1)
      added += 1
    }
    if (ordered.length > added) {
      out._omittedKeys = ordered.length - added
    }
    return out
  }
  return String(value)
}

/**
 * Bounds arbitrary approval tool arguments so live events and `session.attach`
 * snapshots always stay safely within encrypted transport frame limits,
 * returning both the bounded value and whether any truncation occurred.
 */
export function inspectAndBoundApprovalArgs(
  args: unknown,
  maxBytes = MAX_APPROVAL_ARGS_BYTES,
): { readonly value: unknown; readonly truncated: boolean } {
  if (args === undefined || args === null) return { value: args, truncated: false }
  const limit = Math.max(128, Math.floor(maxBytes))
  const rawSerialized = safeJsonStringify(args)
  if (rawSerialized !== undefined && Buffer.byteLength(rawSerialized, 'utf8') <= limit) {
    return { value: args, truncated: false }
  }
  const originalBytes =
    rawSerialized !== undefined ? Buffer.byteLength(rawSerialized, 'utf8') : Buffer.byteLength(String(args), 'utf8')

  if (typeof args === 'string') {
    const suffix = `… [truncated, ${originalBytes} B total]`
    let previewLimit = Math.max(32, limit - Buffer.byteLength(suffix, 'utf8') - 32)
    for (let i = 0; i < 6; i += 1) {
      const candidate = `${truncateUtf8ToBytes(args, previewLimit)}${suffix}`
      if (jsonByteLength(candidate) <= limit) return { value: candidate, truncated: true }
      previewLimit = Math.max(16, Math.floor(previewLimit * 0.6))
    }
    const shortSuffix = '… [truncated]'
    const keepBytes = Math.max(16, Math.floor(limit / 2) - Buffer.byteLength(shortSuffix, 'utf8'))
    return { value: `${truncateUtf8ToBytes(args, keepBytes)}${shortSuffix}`, truncated: true }
  }

  const attempts = [
    { str: Math.max(128, Math.floor(limit / 2)), keys: 24, arr: 16 },
    { str: Math.max(64, Math.floor(limit / 4)), keys: 12, arr: 8 },
    { str: Math.max(48, Math.floor(limit / 8)), keys: 6, arr: 4 },
  ]
  for (const cfg of attempts) {
    const shrunk = shrinkJsonValue(args, cfg.str, cfg.keys, cfg.arr, 0)
    const candidate =
      typeof shrunk === 'object' && shrunk !== null && !Array.isArray(shrunk)
        ? { ...(shrunk as Record<string, unknown>), _truncated: true, _originalBytes: originalBytes }
        : { _truncated: true, _originalBytes: originalBytes, preview: shrunk }
    if (jsonByteLength(candidate) <= limit) {
      return { value: candidate, truncated: true }
    }
  }

  const rawText = rawSerialized ?? String(args)
  let previewBudget = Math.max(24, limit - 96)
  for (let i = 0; i < 6; i += 1) {
    const fallback = {
      _truncated: true,
      _originalBytes: originalBytes,
      preview: truncateUtf8ToBytes(rawText, previewBudget),
    }
    if (jsonByteLength(fallback) <= limit) return { value: fallback, truncated: true }
    previewBudget = Math.max(8, Math.floor(previewBudget * 0.6))
  }
  return { value: { _truncated: true, _originalBytes: originalBytes }, truncated: true }
}

/**
 * Bounds arbitrary approval tool arguments so live events and `session.attach`
 * snapshots always stay safely within encrypted transport frame limits.
 */
export function boundApprovalArgs(args: unknown, maxBytes = MAX_APPROVAL_ARGS_BYTES): unknown {
  return inspectAndBoundApprovalArgs(args, maxBytes).value
}

export function boundPendingApprovalSnapshot(
  approval: PendingApprovalSnapshot,
  maxArgsBytes = MAX_APPROVAL_ARGS_BYTES,
): PendingApprovalSnapshot {
  const boundText = (val: string | undefined): { readonly text: string | undefined; readonly truncated: boolean } => {
    if (val === undefined) return { text: undefined, truncated: false }
    const clean = sanitizeLoneSurrogates(val)
    if (Buffer.byteLength(clean, 'utf8') <= MAX_APPROVAL_TEXT_BYTES) {
      return { text: clean, truncated: false }
    }
    return {
      text: `${truncateUtf8ToBytes(clean, MAX_APPROVAL_TEXT_BYTES - 16)}… [truncated]`,
      truncated: true,
    }
  }
  const boundedReason = boundText(approval.reason)
  const boundedSummary = boundText(approval.summary)
  const boundedArgs =
    approval.args !== undefined ? inspectAndBoundApprovalArgs(approval.args, maxArgsBytes) : undefined
  const argsTruncated =
    approval.argsTruncated === true ||
    boundedArgs?.truncated === true ||
    boundedReason.truncated ||
    boundedSummary.truncated
  return {
    callId: approval.callId,
    toolName: truncateByCodePoints(approval.toolName, 256),
    ...(boundedReason.text !== undefined ? { reason: boundedReason.text } : {}),
    ...(boundedSummary.text !== undefined ? { summary: boundedSummary.text } : {}),
    ...(boundedArgs !== undefined ? { args: boundedArgs.value } : {}),
    ...(argsTruncated ? { argsTruncated: true } : {}),
    ...(approval.sessionId !== undefined ? { sessionId: approval.sessionId } : {}),
  }
}

export function boundApprovalRequestEvent(
  approval: Omit<PendingApprovalSnapshot, 'sessionId'>,
): Record<string, unknown> {
  const bounded = boundPendingApprovalSnapshot(approval)
  return {
    callId: bounded.callId,
    toolName: bounded.toolName,
    ...(bounded.reason !== undefined ? { reason: bounded.reason } : {}),
    ...(bounded.summary !== undefined ? { summary: bounded.summary } : {}),
    ...(bounded.args !== undefined ? { args: bounded.args } : {}),
    ...(bounded.argsTruncated ? { argsTruncated: true } : {}),
  }
}

export function boundLiveStateSnapshot(
  snapshot: SessionLiveStateSnapshot,
  maxBytes = MAX_ATTACH_LIVESTATE_BYTES,
): SessionLiveStateSnapshot {
  const limit = Math.max(2048, Math.floor(maxBytes))
  if (jsonByteLength(snapshot) <= limit) {
    return snapshot
  }

  const applyBudget = (
    perApprovalArgsBytes: number,
    includeTodos: boolean,
    compactQuestions: boolean,
    maxApprovals: number,
  ): SessionLiveStateSnapshot => ({
    ...snapshot,
    pendingApprovals: snapshot.pendingApprovals
      .slice(0, maxApprovals)
      .map((a) => boundPendingApprovalSnapshot(a, perApprovalArgsBytes)),
    pendingQuestions: compactQuestions
      ? snapshot.pendingQuestions.slice(0, 8).map((q) => ({
          questionId: q.questionId,
          prompt: truncateUtf8ToBytes(q.prompt, 512),
          ...(q.sessionId !== undefined ? { sessionId: q.sessionId } : {}),
        }))
      : snapshot.pendingQuestions,
    todos: includeTodos ? snapshot.todos.slice(0, 25) : [],
  })

  const approvalCount = Math.max(1, snapshot.pendingApprovals.length)
  let argsBudget = Math.min(
    MAX_APPROVAL_ARGS_BYTES,
    Math.max(256, Math.floor((limit * 0.6) / approvalCount)),
  )

  for (let pass = 0; pass < 6; pass += 1) {
    const includeTodos = pass < 1
    const compactQuestions = pass >= 1
    const maxApprovals = pass >= 4 ? Math.min(snapshot.pendingApprovals.length, 16) : snapshot.pendingApprovals.length
    const candidate = applyBudget(argsBudget, includeTodos, compactQuestions, maxApprovals)
    if (jsonByteLength(candidate) <= limit) {
      return candidate
    }
    argsBudget = Math.max(128, Math.floor(argsBudget / 2))
  }

  // Last-resort minimal snapshot guaranteed to fit well below frame limit.
  return {
    status: snapshot.status,
    ...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
    ...(snapshot.title !== undefined ? { title: truncateByCodePoints(snapshot.title, 120) } : {}),
    pendingApprovals: snapshot.pendingApprovals.slice(0, 8).map((a) => ({
      callId: a.callId,
      toolName: truncateByCodePoints(a.toolName, 120),
      args: { _truncated: true },
      argsTruncated: true,
      ...(a.sessionId !== undefined ? { sessionId: a.sessionId } : {}),
    })),
    pendingQuestions: snapshot.pendingQuestions.slice(0, 4).map((q) => ({
      questionId: q.questionId,
      prompt: truncateUtf8ToBytes(q.prompt, 256),
      ...(q.sessionId !== undefined ? { sessionId: q.sessionId } : {}),
    })),
    todos: [],
    ...(snapshot.oldestSeq !== undefined ? { oldestSeq: snapshot.oldestSeq } : {}),
    ...(snapshot.latestSeq !== undefined ? { latestSeq: snapshot.latestSeq } : {}),
    ...(snapshot.hasMoreHistory !== undefined ? { hasMoreHistory: snapshot.hasMoreHistory } : {}),
    ...(snapshot.turnCount !== undefined ? { turnCount: snapshot.turnCount } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readFiniteNonNegativeInt(obj: Record<string, unknown> | undefined, keys: readonly string[]): number {
  if (!obj) return 0
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
      return Math.trunc(val)
    }
  }
  return 0
}

function normalizeTodos(rawTodos: unknown): TodoItemSnapshot[] | undefined {
  if (!Array.isArray(rawTodos)) return undefined
  const out: TodoItemSnapshot[] = []
  for (const item of rawTodos) {
    if (!isRecord(item)) continue
    const content = typeof item.content === 'string'
      ? item.content
      : typeof item.title === 'string'
        ? item.title
        : ''
    if (content.trim().length === 0) continue
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : undefined
    const status = typeof item.status === 'string' && item.status.length > 0 ? item.status : 'pending'
    const priority = typeof item.priority === 'string' && item.priority.length > 0 ? item.priority : undefined
    out.push({
      ...(id !== undefined ? { id } : {}),
      content,
      status,
      ...(priority !== undefined ? { priority } : {}),
    })
  }
  return out
}

function extractUsageRecord(event: { readonly type: string; readonly data?: unknown }): Record<string, unknown> | undefined {
  if (!isRecord(event.data)) return undefined
  if (isRecord(event.data.usage)) return event.data.usage
  if (isRecord(event.data.message) && isRecord(event.data.message.usage)) {
    return event.data.message.usage
  }
  if (isRecord(event.data.tokenUsage)) return event.data.tokenUsage
  return undefined
}

export function extractPreviewTextFromEvent(event: { readonly type: string; readonly data?: unknown }): string | undefined {
  if (event.type !== 'user/message' && event.type !== 'assistant/message') return undefined
  if (!isRecord(event.data)) return undefined
  const msg = isRecord(event.data.message) ? event.data.message : event.data
  if (event.type === 'user/message' && isRecord(msg.source) && msg.source.kind !== undefined && msg.source.kind !== 'user') {
    return undefined
  }
  const content = msg.content
  if (typeof content === 'string') {
    const trimmed = content.trim().replace(/\s+/gu, ' ')
    return trimmed.length > 0 ? truncateByCodePoints(trimmed, 140) : undefined
  }
  if (!Array.isArray(content)) return undefined
  const texts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0) {
      texts.push(block.text.trim())
    }
  }
  if (texts.length === 0) return undefined
  const merged = texts.join(' ').replace(/\s+/gu, ' ').trim()
  return merged.length > 0 ? truncateByCodePoints(merged, 140) : undefined
}

export interface FoldedSessionEventsSummary {
  readonly status: 'running' | 'idle'
  readonly title?: string | undefined
  readonly model?: ModelSelectionParams | undefined
  readonly todos: readonly TodoItemSnapshot[]
  readonly usage?: SessionUsageSnapshot | undefined
  readonly preview?: string | undefined
  readonly turnCount: number
}

/**
 * Folds durable DSH session log events using official semantics:
 * - `todo/write` replaces the active todo checklist; next `turn/start` clears it (`dsh-tool-todo`).
 * - `turn/start` / `turn/end` / `agent/status` track turn activity.
 * - `assistant/message` & `step/end` accumulate token counts when reported.
 */
export function foldNormalizedSessionEvents(
  events: readonly { readonly seq?: number; readonly type: string; readonly data?: unknown }[],
  seed?: Partial<FoldedSessionEventsSummary>,
): FoldedSessionEventsSummary {
  let status: 'running' | 'idle' = seed?.status ?? 'idle'
  let title = seed?.title
  let model = seed?.model
  let todos: TodoItemSnapshot[] = seed?.todos ? [...seed.todos] : []
  let preview = seed?.preview
  let turnCount = seed?.turnCount ?? 0
  let inputTokens = seed?.usage?.inputTokens ?? 0
  let outputTokens = seed?.usage?.outputTokens ?? 0
  let cacheReadTokens = seed?.usage?.cacheReadTokens ?? 0
  let cacheWriteTokens = seed?.usage?.cacheWriteTokens ?? 0
  let seenUsage = seed?.usage !== undefined
  const countedStepKeys = new Set<string>()

  for (const event of events) {
    const data = isRecord(event.data) ? event.data : undefined
    switch (event.type) {
      case 'turn/start':
        status = 'running'
        todos = []
        turnCount += 1
        break
      case 'turn/end':
        status = 'idle'
        break
      case 'agent/status':
        if (data?.status === 'running' || data?.status === 'idle') {
          status = data.status
        }
        break
      case 'session/title':
        if (typeof data?.title === 'string' && data.title.trim().length > 0) {
          title = data.title.trim()
        }
        break
      case 'session.model':
      case 'session/model':
      case 'model.selected':
        if (typeof data?.provider === 'string' && typeof data?.model === 'string') {
          model = {
            provider: data.provider,
            model: data.model,
            ...(typeof data.reasoningEffort === 'string' && data.reasoningEffort.length > 0
              ? { reasoningEffort: data.reasoningEffort }
              : {}),
          }
        }
        break
      case 'todo/write': {
        const parsed = normalizeTodos(data?.todos)
        if (parsed !== undefined) {
          todos = parsed
        }
        break
      }
      case 'user/message':
      case 'assistant/message': {
        const extracted = extractPreviewTextFromEvent(event)
        if (extracted !== undefined) {
          preview = extracted
        }
        break
      }
      default:
        break
    }

    if (event.type === 'step/end' || event.type === 'assistant/message' || event.type === 'turn/end') {
      const usageRec = extractUsageRecord(event)
      if (usageRec) {
        const stepKey = typeof event.seq === 'number' ? `${event.type}:${String(event.seq)}` : undefined
        if (stepKey === undefined || !countedStepKeys.has(stepKey)) {
          if (stepKey !== undefined) countedStepKeys.add(stepKey)
          const inTok = readFiniteNonNegativeInt(usageRec, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'])
          const outTok = readFiniteNonNegativeInt(usageRec, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'])
          const crTok = readFiniteNonNegativeInt(usageRec, ['cacheReadTokens', 'cache_read_tokens', 'cacheReadInputTokens', 'cache_read_input_tokens'])
          const cwTok = readFiniteNonNegativeInt(usageRec, ['cacheWriteTokens', 'cache_write_tokens', 'cacheCreationInputTokens', 'cache_creation_input_tokens'])
          if (event.type !== 'turn/end' || (inputTokens === 0 && outputTokens === 0)) {
            inputTokens += inTok
            outputTokens += outTok
            cacheReadTokens += crTok
            cacheWriteTokens += cwTok
          }
          seenUsage = true
        }
      }
    }
  }

  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  const usage: SessionUsageSnapshot | undefined = seenUsage
    ? {
        inputTokens,
        outputTokens,
        ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
        totalTokens,
        turns: turnCount,
      }
    : undefined

  return {
    status,
    ...(title !== undefined ? { title } : {}),
    ...(model !== undefined ? { model } : {}),
    todos,
    ...(usage !== undefined ? { usage } : {}),
    ...(preview !== undefined ? { preview } : {}),
    turnCount,
  }
}

export function buildAttachLiveStateSnapshot(options: {
  readonly folded: FoldedSessionEventsSummary
  readonly liveStatus?: 'running' | 'idle' | undefined
  readonly liveModel?: ModelSelectionParams | undefined
  readonly title?: string | undefined
  readonly pendingApprovals: readonly PendingApprovalSnapshot[]
  readonly pendingQuestions: readonly PendingQuestionSnapshot[]
  readonly oldestSeq?: number | null | undefined
  readonly latestSeq?: number | null | undefined
  readonly hasMoreHistory?: boolean | undefined
}): SessionLiveStateSnapshot {
  return boundLiveStateSnapshot({
    status: options.liveStatus ?? options.folded.status,
    ...((options.liveModel ?? options.folded.model) !== undefined
      ? { model: options.liveModel ?? options.folded.model }
      : {}),
    ...((options.title ?? options.folded.title) !== undefined
      ? { title: options.title ?? options.folded.title }
      : {}),
    pendingApprovals: options.pendingApprovals.map((a) => boundPendingApprovalSnapshot(a)),
    pendingQuestions: [...options.pendingQuestions],
    todos: [...options.folded.todos],
    ...(options.folded.usage !== undefined ? { usage: options.folded.usage } : {}),
    ...(options.oldestSeq !== undefined ? { oldestSeq: options.oldestSeq } : {}),
    ...(options.latestSeq !== undefined ? { latestSeq: options.latestSeq } : {}),
    ...(options.hasMoreHistory !== undefined ? { hasMoreHistory: options.hasMoreHistory } : {}),
    turnCount: options.folded.turnCount,
  })
}
