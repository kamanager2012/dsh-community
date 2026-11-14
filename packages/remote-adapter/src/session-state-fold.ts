import type {
  ModelSelectionParams,
  PendingApprovalSnapshot,
  PendingQuestionSnapshot,
  SessionLiveStateSnapshot,
  SessionUsageSnapshot,
  TodoItemSnapshot,
} from './protocol.js'
import { truncateByCodePoints } from './unicode.js'

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
  return {
    status: options.liveStatus ?? options.folded.status,
    ...((options.liveModel ?? options.folded.model) !== undefined
      ? { model: options.liveModel ?? options.folded.model }
      : {}),
    ...((options.title ?? options.folded.title) !== undefined
      ? { title: options.title ?? options.folded.title }
      : {}),
    pendingApprovals: [...options.pendingApprovals],
    pendingQuestions: [...options.pendingQuestions],
    todos: [...options.folded.todos],
    ...(options.folded.usage !== undefined ? { usage: options.folded.usage } : {}),
    ...(options.oldestSeq !== undefined ? { oldestSeq: options.oldestSeq } : {}),
    ...(options.latestSeq !== undefined ? { latestSeq: options.latestSeq } : {}),
    ...(options.hasMoreHistory !== undefined ? { hasMoreHistory: options.hasMoreHistory } : {}),
    turnCount: options.folded.turnCount,
  }
}
