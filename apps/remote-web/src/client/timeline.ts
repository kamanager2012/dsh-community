import type {
  ModelSelectionParams,
  OfficialSessionEvent,
  PendingApprovalSnapshot,
  PendingQuestionPrompt,
  PendingQuestionSnapshot,
  SessionLiveStateSnapshot,
  SessionUsageSnapshot,
  TimelineItem,
  TodoItemSnapshot,
} from './types.ts'

export interface SessionStoreState {
  readonly sessionId: string
  status: 'running' | 'idle'
  title?: string | undefined
  model?: ModelSelectionParams | undefined
  todos: TodoItemSnapshot[]
  usage?: SessionUsageSnapshot | undefined
  pendingApprovals: PendingApprovalSnapshot[]
  pendingQuestions: PendingQuestionSnapshot[]
  items: TimelineItem[]
  highestSeq: number
  oldestSeq: number | null
  hasMoreHistory: boolean
  unreadCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatJsonCompact(val: unknown): string {
  if (val === undefined || val === null) return ''
  if (typeof val === 'string') return val
  try {
    return JSON.stringify(val, null, 2)
  } catch {
    return String(val)
  }
}

function extractTextFromBlocks(content: unknown): { thinking: string; text: string } {
  if (typeof content === 'string') {
    return { thinking: '', text: content }
  }
  if (!Array.isArray(content)) {
    return { thinking: '', text: '' }
  }
  const thinkingParts: string[] = []
  const textParts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinkingParts.push(block.thinking)
    } else if (block.type === 'thinking' && typeof block.text === 'string') {
      thinkingParts.push(block.text)
    } else if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
    }
  }
  return {
    thinking: thinkingParts.join('\n\n'),
    text: textParts.join('\n\n'),
  }
}

function extractUserMessage(data: Record<string, unknown> | undefined): { text: string; attachments: string[] } | undefined {
  if (!data) return undefined
  const msg = isRecord(data.message) ? data.message : data
  const content = msg.content ?? data.text ?? data.prompt
  const attachments: string[] = []
  if (typeof content === 'string') {
    return { text: content, attachments }
  }
  if (!Array.isArray(content)) {
    return typeof data.prompt === 'string' ? { text: data.prompt, attachments } : undefined
  }
  const textParts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
    } else if (block.type === 'image') {
      attachments.push(typeof block.name === 'string' ? block.name : 'image')
    }
  }
  return { text: textParts.join('\n\n'), attachments }
}

function finalizeOpenAssistants(items: TimelineItem[]): void {
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!
    if (item.kind === 'assistant' && !item.finalized) {
      items[i] = { ...item, finalized: true }
    }
  }
}

export class SessionTimelineState implements SessionStoreState {
  status: 'running' | 'idle' = 'idle'
  title?: string | undefined
  model?: ModelSelectionParams | undefined
  todos: TodoItemSnapshot[] = []
  usage?: SessionUsageSnapshot | undefined
  pendingApprovals: PendingApprovalSnapshot[] = []
  pendingQuestions: PendingQuestionSnapshot[] = []
  items: TimelineItem[] = []
  highestSeq = 0
  oldestSeq: number | null = null
  hasMoreHistory = false
  unreadCount = 0
  private seenKeys = new Set<string>()
  private itemCounter = 0

  constructor(readonly sessionId: string) {}

  private nextId(prefix: string): string {
    this.itemCounter += 1
    return `${prefix}-${this.itemCounter}`
  }

  markRead(): void {
    this.unreadCount = 0
  }

  addOptimisticUserPrompt(text: string, attachmentLabels: readonly string[] = []): void {
    this.items.push({
      kind: 'user',
      id: this.nextId('u'),
      seq: this.highestSeq,
      text,
      attachments: [...attachmentLabels],
      optimistic: true,
    })
  }

  applyLiveStateSnapshot(snap: SessionLiveStateSnapshot | undefined): void {
    if (!snap) return
    this.status = snap.status
    if (snap.title !== undefined) this.title = snap.title
    if (snap.model !== undefined) this.model = snap.model
    this.todos = [...snap.todos]
    if (snap.usage !== undefined) this.usage = snap.usage
    this.pendingApprovals = [...snap.pendingApprovals]
    this.pendingQuestions = [...snap.pendingQuestions]
    if (snap.oldestSeq !== undefined && snap.oldestSeq !== null) this.oldestSeq = snap.oldestSeq
    if (snap.latestSeq !== undefined && snap.latestSeq !== null && snap.latestSeq > this.highestSeq) {
      this.highestSeq = snap.latestSeq
    }
    if (snap.hasMoreHistory !== undefined) this.hasMoreHistory = snap.hasMoreHistory
  }

  prependHistory(events: readonly OfficialSessionEvent[], hasMore: boolean, oldestSeq: number | null): void {
    // Reconstruct timeline in sorted seq order using a clean fold over existing + prepended events
    const combined = new Map<string, OfficialSessionEvent>()
    const existingRaw: OfficialSessionEvent[] = []
    for (const ev of events) {
      const k = `${ev.seq}:${ev.type}`
      if (!this.seenKeys.has(k)) {
        combined.set(k, ev)
      }
    }
    if (combined.size === 0) {
      this.hasMoreHistory = hasMore
      if (oldestSeq !== null) this.oldestSeq = oldestSeq
      return
    }
    const previousItems = this.items
    const previousSeen = new Set(this.seenKeys)
    const fresh = new SessionTimelineState(this.sessionId)
    for (const ev of [...combined.values()].sort((a, b) => a.seq - b.seq)) {
      fresh.applyEvent(ev, { markUnread: false })
    }
    this.items = [...fresh.items, ...previousItems]
    this.seenKeys = new Set([...fresh.seenKeys, ...previousSeen])
    this.hasMoreHistory = hasMore
    if (oldestSeq !== null) this.oldestSeq = oldestSeq
    void existingRaw
  }

  resolveApprovalLocally(callId: string): void {
    this.pendingApprovals = this.pendingApprovals.filter((a) => a.callId !== callId)
  }

  resolveQuestionLocally(questionId: string): void {
    this.pendingQuestions = this.pendingQuestions.filter((q) => q.questionId !== questionId)
  }

  applyEvent(event: OfficialSessionEvent, options?: { readonly markUnread?: boolean | undefined }): void {
    if (typeof event.seq === 'number' && event.seq > 0) {
      const key = `${event.seq}:${event.type}`
      if (this.seenKeys.has(key)) {
        return
      }
      this.seenKeys.add(key)
      if (event.seq > this.highestSeq) {
        this.highestSeq = event.seq
      }
      if (this.oldestSeq === null || event.seq < this.oldestSeq) {
        this.oldestSeq = event.seq
      }
    }

    const markUnread = options?.markUnread ?? true
    const data = isRecord(event.data) ? event.data : undefined
    const evtType = event.type.trim().toLowerCase()

    switch (evtType) {
      case 'user/message':
      case 'user.message':
      case 'prompt': {
        const extracted = extractUserMessage(data)
        if (!extracted) return
        const optIdx = this.items.findIndex(
          (it) => it.kind === 'user' && it.optimistic && it.text.trim() === extracted.text.trim(),
        )
        if (optIdx >= 0) {
          const prev = this.items[optIdx] as Extract<TimelineItem, { kind: 'user' }>
          this.items[optIdx] = {
            ...prev,
            seq: event.seq,
            optimistic: false,
            attachments: extracted.attachments.length > 0 ? extracted.attachments : prev.attachments,
          }
        } else {
          this.items.push({
            kind: 'user',
            id: this.nextId('u'),
            seq: event.seq,
            text: extracted.text,
            attachments: extracted.attachments,
          })
          if (markUnread) this.unreadCount += 1
        }
        return
      }

      case 'assistant/chunk':
      case 'assistant.chunk':
      case 'text-delta':
      case 'reasoning-delta':
      case 'assistant/delta':
      case 'thinking/delta': {
        if (!data) return
        const isThinking =
          evtType === 'reasoning-delta' ||
          evtType === 'thinking/delta' ||
          data.kind === 'thinking' ||
          data.kind === 'reasoning' ||
          data.channel === 'thinking'
        const delta =
          typeof data.delta === 'string'
            ? data.delta
            : typeof data.text === 'string'
              ? data.text
              : typeof data.thinking === 'string'
                ? data.thinking
                : ''
        if (!delta) return

        const tail = this.items[this.items.length - 1]
        if (tail && tail.kind === 'assistant' && !tail.finalized) {
          this.items[this.items.length - 1] = {
            ...tail,
            seq: event.seq,
            thinkingText: isThinking ? tail.thinkingText + delta : tail.thinkingText,
            markdownText: isThinking ? tail.markdownText : tail.markdownText + delta,
          }
        } else {
          this.items.push({
            kind: 'assistant',
            id: this.nextId('a'),
            seq: event.seq,
            thinkingText: isThinking ? delta : '',
            markdownText: isThinking ? '' : delta,
            finalized: false,
          })
          if (markUnread) this.unreadCount += 1
        }
        return
      }

      case 'assistant/message':
      case 'assistant.message': {
        if (!data) return
        const msg = isRecord(data.message) ? data.message : data
        let extracted = extractTextFromBlocks(msg.content)
        if (!extracted.text && !extracted.thinking && typeof data.text === 'string') {
          extracted = { thinking: '', text: data.text }
        }
        const interrupted =
          msg.interrupted === true ||
          data.stopReason === 'aborted' ||
          msg.stopReason === 'aborted'

        let openIdx = -1
        for (let i = this.items.length - 1; i >= 0; i -= 1) {
          const it = this.items[i]!
          if (it.kind === 'assistant' && !it.finalized) {
            openIdx = i
            break
          }
        }

        if (openIdx >= 0) {
          const prev = this.items[openIdx] as Extract<TimelineItem, { kind: 'assistant' }>
          const thinkingText = extracted.thinking || prev.thinkingText
          const markdownText = extracted.text || prev.markdownText
          if (!thinkingText && !markdownText) {
            this.items.splice(openIdx, 1)
          } else {
            this.items[openIdx] = {
              ...prev,
              seq: event.seq,
              thinkingText,
              markdownText,
              finalized: true,
              interrupted: interrupted || prev.interrupted,
            }
          }
        } else if (extracted.thinking || extracted.text) {
          this.items.push({
            kind: 'assistant',
            id: this.nextId('a'),
            seq: event.seq,
            thinkingText: extracted.thinking,
            markdownText: extracted.text,
            finalized: true,
            interrupted,
          })
          if (markUnread) this.unreadCount += 1
        }
        return
      }

      case 'tool/call':
      case 'tool.call': {
        if (!data) return
        finalizeOpenAssistants(this.items)
        const callObj = isRecord(data.call) ? data.call : undefined
        const callId =
          typeof data.callId === 'string'
            ? data.callId
            : typeof callObj?.id === 'string'
              ? callObj.id
              : `call-${event.seq}`
        const toolName = String(
          data.name ?? data.tool ?? data.toolName ?? callObj?.name ?? 'tool',
        )
        const argsRaw = formatJsonCompact(
          data.arguments ?? data.args ?? data.input ?? callObj?.arguments,
        )
        const idx = this.items.findIndex((it) => it.kind === 'tool' && it.callId === callId)
        if (idx >= 0) {
          const prev = this.items[idx] as Extract<TimelineItem, { kind: 'tool' }>
          this.items[idx] = {
            ...prev,
            seq: event.seq,
            toolName,
            argumentsText: argsRaw || prev.argumentsText,
          }
        } else {
          this.items.push({
            kind: 'tool',
            id: this.nextId('t'),
            seq: event.seq,
            callId,
            toolName,
            argumentsText: argsRaw,
            outputText: '',
            status: 'running',
          })
          if (markUnread) this.unreadCount += 1
        }
        return
      }

      case 'tool/result':
      case 'tool.result': {
        if (!data) return
        const msg = isRecord(data.message) ? data.message : data
        const callId = String(msg.callId ?? data.callId ?? '')
        const isErr =
          msg.isError === true ||
          data.isError === true ||
          (typeof data.error === 'string' && data.error.length > 0)
        const rawOutput =
          typeof data.error === 'string'
            ? data.error
            : typeof msg.content === 'string'
              ? msg.content
              : formatJsonCompact(msg.content ?? data.result ?? data.output)
        let idx = -1
        if (callId) {
          idx = this.items.findIndex((it) => it.kind === 'tool' && it.callId === callId)
        } else {
          for (let i = this.items.length - 1; i >= 0; i -= 1) {
            const it = this.items[i]!
            if (it.kind === 'tool' && it.status === 'running') {
              idx = i
              break
            }
          }
        }
        const status = isErr ? 'error' : 'completed'
        if (idx >= 0) {
          const prev = this.items[idx] as Extract<TimelineItem, { kind: 'tool' }>
          this.items[idx] = {
            ...prev,
            seq: event.seq,
            outputText: rawOutput,
            status,
          }
        } else {
          this.items.push({
            kind: 'tool',
            id: this.nextId('t'),
            seq: event.seq,
            callId: callId || `tool-${event.seq}`,
            toolName: String(data.tool ?? 'tool'),
            argumentsText: '',
            outputText: rawOutput,
            status,
          })
        }
        return
      }

      case 'approval.request':
      case 'approval/request': {
        if (!data || typeof data.callId !== 'string') return
        const approval: PendingApprovalSnapshot = {
          callId: data.callId,
          toolName: String(data.toolName ?? data.tool ?? 'tool'),
          ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
          ...(typeof data.summary === 'string' ? { summary: data.summary } : {}),
          sessionId: this.sessionId,
        }
        if (!this.pendingApprovals.some((a) => a.callId === approval.callId)) {
          this.pendingApprovals = [...this.pendingApprovals, approval]
          if (markUnread) this.unreadCount += 1
        }
        return
      }

      case 'approval.resolved': {
        if (data && typeof data.callId === 'string') {
          this.resolveApprovalLocally(data.callId)
        }
        return
      }

      case 'question.request':
      case 'question/ask': {
        if (!data || typeof data.questionId !== 'string') return
        const rawQuestions = Array.isArray(data.questions) ? data.questions : []
        const questions: PendingQuestionPrompt[] = []
        for (const q of rawQuestions) {
          if (!isRecord(q) || typeof q.question !== 'string') continue
          const opts = Array.isArray(q.options)
            ? q.options
                .filter((o): o is Record<string, unknown> => isRecord(o) && typeof o.label === 'string')
                .map((o) => ({
                  label: o.label as string,
                  ...(typeof o.description === 'string' ? { description: o.description } : {}),
                }))
            : undefined
          questions.push({
            question: q.question,
            ...(typeof q.header === 'string' ? { header: q.header } : {}),
            ...(typeof q.multiSelect === 'boolean' ? { multiSelect: q.multiSelect } : {}),
            ...(opts !== undefined ? { options: opts } : {}),
          })
        }
        const promptText =
          typeof data.prompt === 'string'
            ? data.prompt
            : questions.map((q) => q.question).join('\n') || 'Question from agent'
        const snap: PendingQuestionSnapshot = {
          questionId: data.questionId,
          prompt: promptText,
          questions,
          sessionId: this.sessionId,
        }
        if (!this.pendingQuestions.some((q) => q.questionId === snap.questionId)) {
          this.pendingQuestions = [...this.pendingQuestions, snap]
          if (markUnread) this.unreadCount += 1
        }
        return
      }

      case 'question.resolved': {
        if (data && typeof data.questionId === 'string') {
          this.resolveQuestionLocally(data.questionId)
        }
        return
      }

      case 'turn/start':
      case 'turn.start': {
        this.status = 'running'
        this.todos = []
        return
      }

      case 'turn/end':
      case 'turn.end': {
        this.status = 'idle'
        finalizeOpenAssistants(this.items)
        const reasonObj = isRecord(data?.reason) ? data.reason : undefined
        const kind = String(reasonObj?.kind ?? data?.reason ?? '').toLowerCase()
        if (kind === 'aborted') {
          this.items.push({
            kind: 'notice',
            id: this.nextId('n'),
            seq: event.seq,
            text: 'Turn stopped by user',
            isError: false,
          })
        } else if (kind === 'error') {
          const msg = String(reasonObj?.message ?? data?.error ?? 'Turn failed')
          this.items.push({
            kind: 'notice',
            id: this.nextId('n'),
            seq: event.seq,
            text: `Error: ${msg}`,
            isError: true,
          })
        }
        return
      }

      case 'agent/status': {
        if (data?.status === 'running' || data?.status === 'idle') {
          this.status = data.status
        }
        return
      }

      case 'session/title': {
        if (typeof data?.title === 'string' && data.title.trim()) {
          this.title = data.title.trim()
        }
        return
      }

      case 'session.model':
      case 'session/model':
      case 'model.selected': {
        if (typeof data?.provider === 'string' && typeof data?.model === 'string') {
          this.model = {
            provider: data.provider,
            model: data.model,
            ...(typeof data.reasoningEffort === 'string' && data.reasoningEffort
              ? { reasoningEffort: data.reasoningEffort }
              : {}),
          }
        }
        return
      }

      case 'todo/write': {
        if (!Array.isArray(data?.todos)) return
        const next: TodoItemSnapshot[] = []
        for (const row of data.todos) {
          if (!isRecord(row)) continue
          const content = String(row.content ?? row.title ?? '').trim()
          if (!content) continue
          next.push({
            ...(typeof row.id === 'string' ? { id: row.id } : {}),
            content,
            status: String(row.status ?? 'pending'),
            ...(typeof row.priority === 'string' ? { priority: row.priority } : {}),
          })
        }
        this.todos = next
        return
      }

      case 'error':
      case 'session/error': {
        this.items.push({
          kind: 'notice',
          id: this.nextId('n'),
          seq: event.seq,
          text: `Error: ${String(data?.message ?? data?.error ?? event.type)}`,
          isError: true,
        })
      }
    }
  }
}
