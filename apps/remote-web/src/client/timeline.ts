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
  historyHydrated?: boolean | undefined
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

function isChunkEventType(type: string): boolean {
  const evtType = type.trim().toLowerCase()
  return (
    evtType === 'assistant/chunk' ||
    evtType === 'assistant.chunk' ||
    evtType === 'text-delta' ||
    evtType === 'reasoning-delta' ||
    evtType === 'assistant/delta' ||
    evtType === 'thinking/delta'
  )
}

function unwrapAssistantChunk(
  evtType: string,
  data: Record<string, unknown>,
): { delta: string; isThinking: boolean } | undefined {
  const rawChunk = data.chunk
  let chunkRec: Record<string, unknown> | undefined
  let chunkString: string | undefined
  if (typeof rawChunk === 'string') {
    chunkString = rawChunk
  } else if (isRecord(rawChunk)) {
    chunkRec = rawChunk
  }

  const chunkType = String(chunkRec?.type ?? chunkRec?.kind ?? '').trim().toLowerCase()
  const topKind = String(data.kind ?? data.channel ?? '').trim().toLowerCase()
  const isThinking =
    evtType === 'reasoning-delta' ||
    evtType === 'thinking/delta' ||
    chunkType === 'reasoning-delta' ||
    chunkType === 'reasoning' ||
    chunkType === 'thinking-delta' ||
    chunkType === 'thinking' ||
    chunkType === 'thought' ||
    topKind === 'thinking' ||
    topKind === 'reasoning'

  const pickString = (...values: unknown[]): string => {
    for (const v of values) {
      if (typeof v === 'string' && v.length > 0) return v
    }
    return ''
  }

  const delta = chunkString
    ?? pickString(
      chunkRec?.delta,
      chunkRec?.text,
      chunkRec?.thinking,
      chunkRec?.reasoning,
      chunkRec?.content,
      data.delta,
      data.text,
      data.thinking,
    )

  if (!delta) return undefined
  return { delta, isThinking }
}

const MAX_RETAINED_RAW_EVENTS = 4_000

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
  historyHydrated = false
  unreadCount = 0
  private seenKeys = new Set<string>()
  private rawEvents = new Map<string, OfficialSessionEvent>()
  private itemCounter = 0
  private unmergedStreamedAssistantId: string | undefined = undefined
  private compactedBaseline: SessionTimelineState | undefined = undefined
  private compactedMinSeq: number | null = null
  private hasAuthoritativeSnapshot = false

  constructor(readonly sessionId: string) {}

  private nextId(prefix: string): string {
    this.itemCounter += 1
    return `${prefix}-${this.itemCounter}`
  }

  private coalesceContiguousChunksInRawEvents(): void {
    const sorted = [...this.rawEvents.entries()].sort((a, b) => a[1].seq - b[1].seq)
    const next = new Map<string, OfficialSessionEvent>()
    let textBuf: string[] = []
    let lastTextEntry: { key: string; seq: number } | undefined = undefined
    let thinkingBuf: string[] = []
    let lastThinkingEntry: { key: string; seq: number } | undefined = undefined

    const flushChunks = (): void => {
      if (thinkingBuf.length > 0 && lastThinkingEntry) {
        const merged = thinkingBuf.join('')
        next.set(lastThinkingEntry.key, {
          seq: lastThinkingEntry.seq,
          type: 'thinking/delta',
          data: { text: merged, chunk: { type: 'reasoning-delta', text: merged } },
        })
      }
      if (textBuf.length > 0 && lastTextEntry) {
        const merged = textBuf.join('')
        next.set(lastTextEntry.key, {
          seq: lastTextEntry.seq,
          type: 'assistant/chunk',
          data: { text: merged, chunk: { type: 'text-delta', text: merged } },
        })
      }
      textBuf = []
      lastTextEntry = undefined
      thinkingBuf = []
      lastThinkingEntry = undefined
    }

    for (const [k, ev] of sorted) {
      const evtType = ev.type.trim().toLowerCase()
      if (isChunkEventType(evtType) && isRecord(ev.data)) {
        const unwrapped = unwrapAssistantChunk(evtType, ev.data)
        if (unwrapped) {
          if (unwrapped.isThinking) {
            thinkingBuf.push(unwrapped.delta)
            lastThinkingEntry = { key: k, seq: ev.seq }
          } else {
            textBuf.push(unwrapped.delta)
            lastTextEntry = { key: k, seq: ev.seq }
          }
          continue
        }
      }
      flushChunks()
      next.set(k, ev)
    }
    flushChunks()
    this.rawEvents = next
  }

  private rememberRawEvent(key: string, event: OfficialSessionEvent): void {
    this.rawEvents.set(key, event)
    if (this.rawEvents.size <= MAX_RETAINED_RAW_EVENTS) return

    this.coalesceContiguousChunksInRawEvents()
    if (this.rawEvents.size <= MAX_RETAINED_RAW_EVENTS) return

    const sorted = [...this.rawEvents.entries()].sort((a, b) => a[1].seq - b[1].seq)
    const overflow = sorted.length - MAX_RETAINED_RAW_EVENTS
    if (overflow <= 0) return

    if (!this.compactedBaseline) {
      this.compactedBaseline = new SessionTimelineState(this.sessionId)
    }
    for (let i = 0; i < overflow; i += 1) {
      const [evKey, ev] = sorted[i]!
      this.compactedBaseline.applyEvent(ev, { markUnread: false, skipRawStore: true })
      if (typeof ev.seq === 'number' && ev.seq > 0) {
        if (this.compactedMinSeq === null || ev.seq < this.compactedMinSeq) {
          this.compactedMinSeq = ev.seq
        }
      }
      this.rawEvents.delete(evKey)
    }
  }

  markRead(): void {
    this.unreadCount = 0
  }

  addOptimisticUserPrompt(text: string, attachmentLabels: readonly string[] = []): string {
    const id = this.nextId('u')
    this.items.push({
      kind: 'user',
      id,
      seq: this.highestSeq,
      text,
      attachments: [...attachmentLabels],
      optimistic: true,
    })
    return id
  }

  removeOptimisticItem(id: string): void {
    this.items = this.items.filter((it) => it.id !== id)
  }

  addLocalNotice(text: string, isError = false): void {
    this.items.push({
      kind: 'notice',
      id: this.nextId('n'),
      seq: this.highestSeq,
      text,
      isError,
    })
  }

  applyLiveStateSnapshot(snap: SessionLiveStateSnapshot | undefined): void {
    if (!snap) return
    this.hasAuthoritativeSnapshot = true
    this.status = snap.status
    if (snap.title !== undefined) this.title = snap.title
    if (snap.model !== undefined) this.model = snap.model
    this.todos = [...snap.todos]
    if (snap.usage !== undefined) this.usage = snap.usage
    const prevByCallId = new Map(this.pendingApprovals.map((a) => [a.callId, a]))
    this.pendingApprovals = snap.pendingApprovals.map((approval) => {
      const prev = prevByCallId.get(approval.callId)
      if (approval.argsTruncated && prev && prev.args !== undefined && !prev.argsTruncated) {
        return { ...approval, args: prev.args, argsTruncated: undefined }
      }
      if (approval.args !== undefined) return approval
      if (prev?.args !== undefined) {
        return {
          ...approval,
          args: prev.args,
          ...(prev.argsTruncated ? { argsTruncated: true } : {}),
        }
      }
      const matchedTool = this.items.find(
        (it): it is Extract<TimelineItem, { kind: 'tool' }> =>
          it.kind === 'tool' && it.callId === approval.callId && it.argumentsText.length > 0,
      )
      return matchedTool ? { ...approval, args: matchedTool.argumentsText } : approval
    })
    this.pendingQuestions = [...snap.pendingQuestions]
    // Preserve materialized event cursors (oldestSeq / highestSeq); live snapshots must never
    // synthesize loaded boundaries ahead of events actually hydrated on the client.
    if (snap.hasMoreHistory !== undefined) this.hasMoreHistory = snap.hasMoreHistory
  }

  private rebuildChronological(options?: {
    readonly markOpenFinalizedBeforeSeq?: number | undefined
    readonly preserveRuntimeState?: boolean | undefined
  }): void {
    const markOpenFinalizedBeforeSeq = options?.markOpenFinalizedBeforeSeq
    const preserveRuntimeState = options?.preserveRuntimeState === true
    const optimisticTrailing = this.items.filter(
      (it): it is Extract<TimelineItem, { kind: 'user' }> => it.kind === 'user' && it.optimistic === true,
    )
    const sorted = [...this.rawEvents.values()].sort((a, b) => a.seq - b.seq)
    const savedUnread = this.unreadCount
    const savedStatus = this.status
    const savedTitle = this.title
    const savedModel = this.model
    const savedTodos = this.todos
    const savedUsage = this.usage
    const savedApprovals = this.pendingApprovals
    const savedQuestions = this.pendingQuestions
    const savedHasMore = this.hasMoreHistory
    const savedOldest = this.oldestSeq

    const base = this.compactedBaseline
    this.items = base ? base.items.map((it) => ({ ...it })) : []
    this.seenKeys = base ? new Set(base.seenKeys) : new Set()
    this.highestSeq = base ? base.highestSeq : 0
    this.oldestSeq = base ? base.oldestSeq : null
    this.unmergedStreamedAssistantId = base?.unmergedStreamedAssistantId
    if (base) {
      this.status = base.status
      this.title = base.title
      this.model = base.model
      this.todos = [...base.todos]
      this.usage = base.usage
      this.pendingApprovals = [...base.pendingApprovals]
      this.pendingQuestions = [...base.pendingQuestions]
    }

    let crossedThreshold = false
    for (const ev of sorted) {
      if (
        markOpenFinalizedBeforeSeq !== undefined &&
        !crossedThreshold &&
        ev.seq >= markOpenFinalizedBeforeSeq
      ) {
        crossedThreshold = true
        finalizeOpenAssistants(this.items)
        this.unmergedStreamedAssistantId = undefined
      }
      this.applyEvent(ev, { markUnread: false, skipRawStore: true })
    }

    for (const opt of optimisticTrailing) {
      const matched = this.items.some(
        (it) => it.kind === 'user' && !it.optimistic && it.text.trim() === opt.text.trim(),
      )
      if (!matched) {
        this.items.push(opt)
      }
    }

    this.unreadCount = savedUnread
    this.hasMoreHistory = savedHasMore
    if (savedOldest !== null && (this.oldestSeq === null || savedOldest < this.oldestSeq)) {
      this.oldestSeq = savedOldest
    }
    if (preserveRuntimeState || sorted.length === 0) {
      this.status = savedStatus
      this.title = savedTitle
      this.model = savedModel
      this.todos = savedTodos
      this.usage = savedUsage
      this.pendingApprovals = savedApprovals
      this.pendingQuestions = savedQuestions
    }
  }

  prependHistory(events: readonly OfficialSessionEvent[], hasMore: boolean, oldestSeq: number | null): void {
    let added = false
    const preCompacted: OfficialSessionEvent[] = []
    for (const ev of events) {
      const k = `${ev.seq}:${ev.type}`
      if (this.compactedBaseline && this.compactedMinSeq !== null && ev.seq < this.compactedMinSeq) {
        if (!this.seenKeys.has(k)) {
          preCompacted.push(ev)
          this.seenKeys.add(k)
          added = true
        }
        continue
      }
      if (!this.rawEvents.has(k) && !(this.compactedBaseline && this.seenKeys.has(k))) {
        this.rememberRawEvent(k, ev)
        added = true
      }
    }
    if (preCompacted.length > 0 && this.compactedBaseline) {
      const prefix = new SessionTimelineState(this.sessionId)
      const sortedPrefix = [...preCompacted].sort((a, b) => a.seq - b.seq)
      for (const ev of sortedPrefix) {
        prefix.applyEvent(ev, { markUnread: false, skipRawStore: true })
        if (typeof ev.seq === 'number' && ev.seq > 0 && (this.compactedMinSeq === null || ev.seq < this.compactedMinSeq)) {
          this.compactedMinSeq = ev.seq
        }
      }
      finalizeOpenAssistants(prefix.items)
      const prevBase = this.compactedBaseline
      prevBase.items = [...prefix.items, ...prevBase.items]
      for (const sk of prefix.seenKeys) {
        prevBase.seenKeys.add(sk)
      }
      if (prefix.oldestSeq !== null && (prevBase.oldestSeq === null || prefix.oldestSeq < prevBase.oldestSeq)) {
        prevBase.oldestSeq = prefix.oldestSeq
      }
    }
    if (added) {
      this.rebuildChronological({ preserveRuntimeState: true })
    }
    this.hasMoreHistory = hasMore
    if (oldestSeq !== null) this.oldestSeq = oldestSeq
    this.historyHydrated = true
  }

  applyResetRecoveryHistory(
    events: readonly OfficialSessionEvent[],
    hasMore: boolean,
    oldestSeq: number | null,
  ): void {
    if (events.length > 0) {
      let minRecSeq = Number.POSITIVE_INFINITY
      for (const ev of events) {
        if (ev.seq < minRecSeq) minRecSeq = ev.seq
      }
      for (const [k, ev] of this.rawEvents.entries()) {
        if (!hasMore || ev.seq >= minRecSeq || (isChunkEventType(ev.type) && ev.seq >= minRecSeq)) {
          this.rawEvents.delete(k)
        }
      }
      for (const ev of events) {
        this.rememberRawEvent(`${ev.seq}:${ev.type}`, ev)
      }
      this.rebuildChronological({
        markOpenFinalizedBeforeSeq: Number.isFinite(minRecSeq) ? minRecSeq : undefined,
        preserveRuntimeState: this.hasAuthoritativeSnapshot,
      })
    } else {
      for (const [k, ev] of this.rawEvents.entries()) {
        if (!hasMore && isChunkEventType(ev.type)) {
          this.rawEvents.delete(k)
        }
      }
      finalizeOpenAssistants(this.items)
      this.unmergedStreamedAssistantId = undefined
    }

    this.hasMoreHistory = hasMore
    if (oldestSeq !== null) {
      this.oldestSeq = oldestSeq
    }
    this.historyHydrated = true
  }

  resolveApprovalLocally(callId: string): void {
    this.pendingApprovals = this.pendingApprovals.filter((a) => a.callId !== callId)
  }

  resolveQuestionLocally(questionId: string): void {
    this.pendingQuestions = this.pendingQuestions.filter((q) => q.questionId !== questionId)
  }

  applyEvent(
    event: OfficialSessionEvent,
    options?: { readonly markUnread?: boolean | undefined; readonly skipRawStore?: boolean | undefined },
  ): void {
    if (typeof event.seq === 'number' && event.seq > 0) {
      const key = `${event.seq}:${event.type}`
      if (this.seenKeys.has(key)) {
        return
      }
      this.seenKeys.add(key)
      if (!options?.skipRawStore) {
        this.rememberRawEvent(key, event)
      }
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
        this.unmergedStreamedAssistantId = undefined
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
        const unwrapped = unwrapAssistantChunk(evtType, data)
        if (!unwrapped) return
        const { delta, isThinking } = unwrapped

        const tail = this.items[this.items.length - 1]
        if (tail && tail.kind === 'assistant' && !tail.finalized) {
          this.unmergedStreamedAssistantId = tail.id
          this.items[this.items.length - 1] = {
            ...tail,
            seq: event.seq,
            thinkingText: isThinking ? tail.thinkingText + delta : tail.thinkingText,
            markdownText: isThinking ? tail.markdownText : tail.markdownText + delta,
          }
        } else {
          const id = this.nextId('a')
          this.unmergedStreamedAssistantId = id
          this.items.push({
            kind: 'assistant',
            id,
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
          if (
            it.kind === 'assistant' &&
            (!it.finalized ||
              (this.unmergedStreamedAssistantId !== undefined && it.id === this.unmergedStreamedAssistantId))
          ) {
            openIdx = i
            break
          }
        }
        this.unmergedStreamedAssistantId = undefined

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
        this.unmergedStreamedAssistantId = undefined
        if (!data) return
        const msg = isRecord(data.message) ? data.message : data
        const callId = String(msg.callId ?? data.callId ?? '')
        const rawError = data.error !== undefined ? data.error : msg.error
        const isErr =
          msg.isError === true ||
          data.isError === true ||
          (typeof rawError === 'string' && rawError.length > 0) ||
          isRecord(rawError)
        const errorText =
          typeof rawError === 'string' && rawError.length > 0
            ? rawError
            : isRecord(rawError)
              ? formatJsonCompact(rawError)
              : ''
        const rawOutput =
          errorText.length > 0
            ? errorText
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
        const matchedTool = this.items.find(
          (it): it is Extract<TimelineItem, { kind: 'tool' }> =>
            it.kind === 'tool' && it.callId === data.callId && it.argumentsText.length > 0,
        )
        const rawArgs =
          data.args !== undefined
            ? data.args
            : data.input !== undefined
              ? data.input
              : data.rawInput !== undefined
                ? data.rawInput
                : data.locations !== undefined
                  ? data.locations
                  : matchedTool?.argumentsText
        const approval: PendingApprovalSnapshot = {
          callId: data.callId,
          toolName: String(data.toolName ?? data.tool ?? 'tool'),
          ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
          ...(typeof data.summary === 'string' ? { summary: data.summary } : {}),
          ...(rawArgs !== undefined ? { args: rawArgs } : {}),
          ...(data.argsTruncated === true ? { argsTruncated: true } : {}),
          sessionId: this.sessionId,
        }
        const existingIdx = this.pendingApprovals.findIndex((a) => a.callId === approval.callId)
        if (existingIdx < 0) {
          this.pendingApprovals = [...this.pendingApprovals, approval]
          if (markUnread) this.unreadCount += 1
        } else {
          const prev = this.pendingApprovals[existingIdx]!
          if (
            (prev.args === undefined || (prev.argsTruncated && !approval.argsTruncated)) &&
            approval.args !== undefined
          ) {
            this.pendingApprovals = this.pendingApprovals.map((a, idx) =>
              idx === existingIdx ? { ...a, ...approval } : a,
            )
          }
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
            id: typeof q.id === 'string' && q.id.length > 0 ? q.id : `q${questions.length + 1}`,
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
        this.unmergedStreamedAssistantId = undefined
        this.status = 'running'
        this.todos = []
        return
      }

      case 'turn/end':
      case 'turn.end': {
        this.unmergedStreamedAssistantId = undefined
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
      case 'session/error':
      case 'agent/error':
      case 'agent.error': {
        this.unmergedStreamedAssistantId = undefined
        const errText =
          typeof data?.message === 'string' && data.message.length > 0
            ? data.message
            : typeof data?.error === 'string' && data.error.length > 0
              ? data.error
              : isRecord(data?.error)
                ? formatJsonCompact(data.error)
                : event.type
        this.items.push({
          kind: 'notice',
          id: this.nextId('n'),
          seq: event.seq,
          text: `Error: ${errText}`,
          isError: true,
        })
      }
    }
  }
}
