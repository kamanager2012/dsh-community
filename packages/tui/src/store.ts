import type { UserQuestionAnswer, UserQuestionRequest } from './types.ts'

export type UiItem =
  | { readonly kind: 'help'; readonly id: string; readonly text: string }
  | { readonly kind: 'notice'; readonly id: string; readonly text: string; readonly tone: 'info' | 'warn' | 'error' }
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'assistant'; readonly id: string; readonly text: string; readonly reasoning: string; readonly final: boolean }
  | { readonly kind: 'tool'; readonly id: string; readonly name: string; readonly args: string; readonly done: boolean; readonly summary: string; readonly isError?: boolean }

export interface TodoItem {
  readonly id?: string
  readonly content: string
  readonly status: string
  readonly priority?: string
}

export interface TokenUsageSummary {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly turns: number
}

export interface CommandSummary {
  readonly name: string
  readonly description: string
  readonly inputHint?: string
}

export interface ApprovalPrompt {
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
}

export interface QuestionPrompt {
  readonly request: UserQuestionRequest
}

export interface UiState {
  readonly draft: string
  readonly items: readonly UiItem[]
  readonly status: string
  readonly model: string
  readonly title: string | undefined
  readonly todos: readonly TodoItem[]
  readonly usage: TokenUsageSummary
  readonly commands: readonly CommandSummary[]
  readonly approval: ApprovalPrompt | undefined
  readonly questions: QuestionPrompt | undefined
  readonly fatal: string | undefined
}

const EMPTY_USAGE: TokenUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turns: 0,
}

const EMPTY: UiState = {
  draft: '',
  items: [],
  status: 'idle',
  model: 'default',
  title: undefined,
  todos: [],
  usage: EMPTY_USAGE,
  commands: [],
  approval: undefined,
  questions: undefined,
  fatal: undefined,
}

/** One durable session event inside the `session/event` log batch. */
interface SessionEventLike {
  readonly type?: unknown
  readonly seq?: unknown
  readonly data?: Record<string, unknown>
}

function displayOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const lines: string[] = []

  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const value = block as Record<string, unknown>
    if (value.type === 'text') {
      const text = String(value.text ?? '')
      if (text !== '') lines.push(text)
      continue
    }
    if (value.type !== 'image') continue

    const attachment = value.attachment
    if (typeof attachment !== 'object' || attachment === null) {
      lines.push('[图片]')
      continue
    }
    const ref = attachment as Record<string, unknown>
    const name = typeof ref.name === 'string' && ref.name !== '' ? `: ${ref.name}` : ''
    const width = typeof ref.width === 'number' ? ref.width : undefined
    const height = typeof ref.height === 'number' ? ref.height : undefined
    const dimensions = width === undefined || height === undefined
      ? ''
      : ` ${String(width)}×${String(height)}`
    lines.push(`[图片${name}${dimensions}]`)
  }

  return lines.join('\n')
}

function readNonNegInt(rec: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const v = rec[key]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.trunc(v)
  }
  return 0
}

function extractThinkingOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const raw of blocks) {
    if (typeof raw !== 'object' || raw === null) continue
    const b = raw as Record<string, unknown>
    if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking !== '') {
      parts.push(b.thinking)
    } else if (b.type === 'reasoning' && typeof b.text === 'string' && b.text !== '') {
      parts.push(b.text)
    }
  }
  return parts.join('\n')
}

function normalizeTodoList(raw: unknown): TodoItem[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: TodoItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const rec = entry as Record<string, unknown>
    const content = typeof rec.content === 'string'
      ? rec.content
      : typeof rec.title === 'string'
        ? rec.title
        : ''
    if (content.trim() === '') continue
    out.push({
      ...(typeof rec.id === 'string' && rec.id !== '' ? { id: rec.id } : {}),
      content,
      status: typeof rec.status === 'string' && rec.status !== '' ? rec.status : 'pending',
      ...(typeof rec.priority === 'string' && rec.priority !== '' ? { priority: rec.priority } : {}),
    })
  }
  return out
}

function patchUsageFromEvent(
  eventType: string,
  seq: number,
  data: Record<string, unknown>,
  current: TokenUsageSummary,
  countedKeys: Set<string>,
): TokenUsageSummary | undefined {
  const usageRaw =
    (typeof data.usage === 'object' && data.usage !== null ? data.usage : undefined) ??
    (typeof data.message === 'object' && data.message !== null && typeof (data.message as Record<string, unknown>).usage === 'object'
      ? (data.message as Record<string, unknown>).usage
      : undefined)
  if (!usageRaw || typeof usageRaw !== 'object') return undefined
  const usage = usageRaw as Record<string, unknown>
  const key = `${eventType}:${String(seq)}`
  if (countedKeys.has(key)) return undefined
  countedKeys.add(key)
  if (eventType === 'turn/end' && (current.inputTokens > 0 || current.outputTokens > 0)) {
    return undefined
  }
  return {
    inputTokens: current.inputTokens + readNonNegInt(usage, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens']),
    outputTokens: current.outputTokens + readNonNegInt(usage, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens']),
    cacheReadTokens: current.cacheReadTokens + readNonNegInt(usage, ['cacheReadTokens', 'cache_read_tokens', 'cacheReadInputTokens']),
    cacheWriteTokens: current.cacheWriteTokens + readNonNegInt(usage, ['cacheWriteTokens', 'cache_write_tokens', 'cacheCreationInputTokens']),
    turns: current.turns,
  }
}

function summaryOfToolResult(data: Record<string, unknown>): string {
  const meta = data.meta
  if (typeof meta === 'object' && meta !== null) {
    const summary = (meta as Record<string, unknown>).summary
    if (typeof summary === 'string' && summary !== '') return summary
  }
  const content = data.content
  if (Array.isArray(content)) {
    const text = content
      .filter((block): block is { type: 'text'; text?: unknown } =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text',
      )
      .map((block) => String(block.text ?? ''))
      .join(' ')
      .trim()
    if (text !== '') {
      const clipped = text.replaceAll(/\s+/gu, ' ')
      return clipped.length > 160 ? `${clipped.slice(0, 160)}…` : clipped
    }
  }
  return 'done'
}

export interface UiStore {
  readonly state: UiState
  subscribe(listener: () => void): () => void
  applySessionEvent(payload: unknown): void
  setStatus(status: string): void
  setModel(model: string): void
  setTitle(title: string | undefined): void
  setCommands(commands: readonly CommandSummary[]): void
  setFatal(message: string): void
  setDraft(text: string): void
  recordPrompt(prompt: string): void
  recallPreviousPrompt(): void
  recallNextPrompt(): void
  showHelp(text: string): void
  showNotice(text: string, tone?: 'info' | 'warn' | 'error'): void
  askApproval(prompt: ApprovalPrompt, signal?: AbortSignal): Promise<string>
  resolveApproval(outcome: string): void
  askQuestions(request: UserQuestionRequest): Promise<UserQuestionAnswer>
  resolveQuestions(answer: UserQuestionAnswer): void
}

export function createStore(): UiStore {
  let state: UiState = EMPTY
  let lastSeq = -1
  const listeners = new Set<() => void>()
  const promptHistory: string[] = []
  let historyCursor = -1
  let stashedDraft = ''
  const countedUsageKeys = new Set<string>()
  let approvalWaiter: ((outcome: string) => void) | undefined
  let cleanupApprovalAbort: (() => void) | undefined
  let questionWaiter: {
    readonly resolve: (answer: UserQuestionAnswer) => void
    readonly reject: (error: Error) => void
  } | undefined
  let cleanupQuestionAbort: (() => void) | undefined

  const emit = (): void => {
    for (const listener of listeners) listener()
  }

  const set = (patch: Partial<UiState>): void => {
    state = { ...state, ...patch }
    emit()
  }

  const patchLast = (kind: UiItem['kind'], update: (item: UiItem) => UiItem): void => {
    const index = state.items.map((item) => item.kind).lastIndexOf(kind)
    if (index < 0) return
    const next = state.items.slice()
    next[index] = update(next[index]!)
    state = { ...state, items: next }
    emit()
  }

  const applyEvent = (event: SessionEventLike): void => {
    const type = event.type
    if (typeof type !== 'string') return
    const seq = typeof event.seq === 'number' ? event.seq : lastSeq + 1
    if (seq <= lastSeq) return
    lastSeq = seq
    const data = event.data ?? {}

    if (type === 'turn/start') {
      set({
        status: 'running',
        todos: [],
        usage: { ...state.usage, turns: state.usage.turns + 1 },
      })
      return
    }
    if (type === 'turn/end') {
      const nextUsage = patchUsageFromEvent(type, seq, data, state.usage, countedUsageKeys)
      const nextItems = [...state.items]
      const stopReason = typeof data.stopReason === 'string'
        ? data.stopReason
        : typeof data.reason === 'string'
          ? data.reason
          : ''
      if (stopReason === 'interrupted' || stopReason === 'aborted') {
        nextItems.push({ kind: 'notice', id: `notice-${seq}`, text: '本轮已中断', tone: 'warn' })
      } else if (typeof data.error === 'string' && data.error.trim() !== '') {
        nextItems.push({ kind: 'notice', id: `notice-${seq}`, text: `回合异常：${data.error}`, tone: 'error' })
      }
      set({
        status: 'idle',
        ...(nextUsage ? { usage: nextUsage } : {}),
        ...(nextItems.length !== state.items.length ? { items: nextItems } : {}),
      })
      return
    }
    if (type === 'step/end') {
      const nextUsage = patchUsageFromEvent(type, seq, data, state.usage, countedUsageKeys)
      if (nextUsage) set({ usage: nextUsage })
      return
    }
    if (type === 'todo/write') {
      const parsedTodos = normalizeTodoList(data.todos)
      if (parsedTodos !== undefined) {
        set({ todos: parsedTodos })
      }
      return
    }
    if (type === 'session/title') {
      const nextTitle = typeof data.title === 'string' ? data.title.trim() : ''
      if (nextTitle !== '') {
        set({ title: nextTitle })
      }
      return
    }
    if (type === 'session.model' || type === 'session/model' || type === 'model.selected') {
      if (typeof data.model === 'string' && data.model !== '') {
        set({ model: data.model })
      }
      return
    }
    if (type === 'compaction') {
      const summary = typeof data.summary === 'string' && data.summary.trim() !== ''
        ? `上下文已压缩：${data.summary.trim().slice(0, 80)}`
        : '上下文已压缩'
      set({
        items: [...state.items, { kind: 'notice', id: `notice-${seq}`, text: summary, tone: 'info' }],
      })
      return
    }
    if (type === 'user/message') {
      const message = data.message !== undefined && typeof data.message === 'object'
        ? data.message as Record<string, unknown>
        : data
      const source = message.source
      if (typeof source === 'object' && source !== null && (source as { kind?: unknown }).kind !== 'user') return
      const text = typeof message.content === 'string'
        ? message.content.trim()
        : displayOfBlocks(message.content)
      if (text === '') return
      set({ items: [...state.items, { kind: 'user', id: String(seq), text }] })
      return
    }
    if (type === 'assistant/chunk') {
      const chunk = data.chunk
      if (typeof chunk !== 'object' || chunk === null) return
      const c = chunk as Record<string, unknown>
      const last = state.items[state.items.length - 1]
      if (last?.kind !== 'assistant' || last.final) {
        set({ items: [...state.items, { kind: 'assistant', id: String(seq), text: '', reasoning: '', final: false }] })
      }
      if (c.type === 'text-delta') {
        patchLast('assistant', (item) => item.kind === 'assistant' ? { ...item, text: item.text + String(c.text ?? '') } : item)
      } else if (c.type === 'reasoning-delta') {
        patchLast('assistant', (item) => item.kind === 'assistant' ? { ...item, reasoning: item.reasoning + String(c.text ?? '') } : item)
      } else if (c.type === 'tool-call-delta') {
        const callId = String(c.id ?? 'call')
        if (!state.items.some((item) => item.kind === 'tool' && item.id === callId)) {
          set({ items: [...state.items, { kind: 'tool', id: callId, name: String(c.name ?? 'tool'), args: String(c.argumentsDelta ?? ''), done: false, summary: '' }] })
        }
      }
      return
    }
    if (type === 'assistant/message') {
      const nextUsage = patchUsageFromEvent(type, seq, data, state.usage, countedUsageKeys)
      const last = state.items[state.items.length - 1]
      if (last?.kind === 'assistant' && !last.final) {
        patchLast('assistant', (item) => item.kind === 'assistant' ? { ...item, final: true } : item)
        if (nextUsage) set({ usage: nextUsage })
      } else {
        const message = data.message !== undefined && typeof data.message === 'object'
          ? data.message as Record<string, unknown>
          : data
        const text = typeof message.content === 'string'
          ? message.content.trim()
          : displayOfBlocks(message.content)
        const reasoning = extractThinkingOfBlocks(message.content)
        if (text !== '' || reasoning !== '') {
          set({
            items: [...state.items, { kind: 'assistant', id: String(seq), text, reasoning, final: true }],
            ...(nextUsage ? { usage: nextUsage } : {}),
          })
        } else if (nextUsage) {
          set({ usage: nextUsage })
        }
      }
      return
    }
    if (type === 'tool/call') {
      const callId = String(data.callId ?? 'call')
      if (!state.items.some((item) => item.kind === 'tool' && item.id === callId)) {
        set({ items: [...state.items, { kind: 'tool', id: callId, name: String(data.name ?? 'tool'), args: String(data.arguments ?? ''), done: false, summary: '' }] })
      }
      return
    }
    if (type === 'tool/result') {
      const callId = String(data.callId ?? 'call')
      const summary = summaryOfToolResult(data)
      const isError = data.isError === true
      set({
        items: state.items.map((item) =>
          item.kind === 'tool' && item.id === callId
            ? { ...item, done: true, summary, ...(isError ? { isError: true } : {}) }
            : item,
        ),
      })
      return
    }
  }

  return {
    get state() {
      return state
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    applySessionEvent(payload) {
      if (typeof payload !== 'object' || payload === null) return
      const log = (payload as Record<string, unknown>).log
      if (!Array.isArray(log)) return
      for (const item of log) {
        if (typeof item === 'object' && item !== null) {
          applyEvent(item as SessionEventLike)
        }
      }
    },
    setStatus(status) {
      set({ status })
    },
    setModel(model) {
      set({ model })
    },
    setTitle(title) {
      set({ title })
    },
    setCommands(commands) {
      set({ commands: [...commands] })
    },
    setFatal(message) {
      set({ fatal: message })
    },
    setDraft(text) {
      historyCursor = -1
      set({ draft: text })
    },
    recordPrompt(prompt) {
      const clean = prompt.trim()
      if (clean !== '' && promptHistory[promptHistory.length - 1] !== clean) {
        promptHistory.push(clean)
        if (promptHistory.length > 50) promptHistory.shift()
      }
      historyCursor = -1
      stashedDraft = ''
    },
    recallPreviousPrompt() {
      if (promptHistory.length === 0) return
      if (historyCursor === -1) {
        stashedDraft = state.draft
        historyCursor = promptHistory.length - 1
      } else if (historyCursor > 0) {
        historyCursor -= 1
      }
      set({ draft: promptHistory[historyCursor] ?? '' })
    },
    recallNextPrompt() {
      if (historyCursor === -1) return
      if (historyCursor < promptHistory.length - 1) {
        historyCursor += 1
        set({ draft: promptHistory[historyCursor] ?? '' })
      } else {
        historyCursor = -1
        set({ draft: stashedDraft })
      }
    },
    showHelp(text) {
      set({ items: [...state.items, { kind: 'help', id: String(state.items.length), text }] })
    },
    showNotice(text, tone = 'info') {
      set({ items: [...state.items, { kind: 'notice', id: `notice-${state.items.length}`, text, tone }] })
    },
    askApproval(prompt, signal) {
      if (approvalWaiter !== undefined) {
        return Promise.reject(
          new Error('an approval prompt is already pending; resolve it before requesting another'),
        )
      }
      if (signal?.aborted) {
        return Promise.resolve('cancelled')
      }
      set({ approval: prompt })
      return new Promise<string>((resolve) => {
        approvalWaiter = resolve
        if (signal !== undefined) {
          const onAbort = (): void => {
            cleanupApprovalAbort = undefined
            const waiter = approvalWaiter
            approvalWaiter = undefined
            set({ approval: undefined })
            waiter?.('cancelled')
          }
          signal.addEventListener('abort', onAbort, { once: true })
          cleanupApprovalAbort = () => signal.removeEventListener('abort', onAbort)
        }
      })
    },
    resolveApproval(outcome) {
      cleanupApprovalAbort?.()
      cleanupApprovalAbort = undefined
      const waiter = approvalWaiter
      approvalWaiter = undefined
      set({ approval: undefined })
      waiter?.(outcome)
    },
    askQuestions(request) {
      if (questionWaiter !== undefined) {
        return Promise.reject(
          new Error('a question prompt is already pending; answer it before requesting another'),
        )
      }
      if (request.signal?.aborted) {
        return Promise.reject(new Error('question request aborted'))
      }
      set({ questions: { request } })
      return new Promise<UserQuestionAnswer>((resolve, reject) => {
        questionWaiter = { resolve, reject }
        const signal = request.signal
        if (signal !== undefined) {
          const onAbort = (): void => {
            cleanupQuestionAbort = undefined
            const waiter = questionWaiter
            questionWaiter = undefined
            set({ questions: undefined })
            waiter?.reject(new Error('question request aborted'))
          }
          signal.addEventListener('abort', onAbort, { once: true })
          cleanupQuestionAbort = () => signal.removeEventListener('abort', onAbort)
        }
      })
    },
    resolveQuestions(answer) {
      cleanupQuestionAbort?.()
      cleanupQuestionAbort = undefined
      const waiter = questionWaiter
      questionWaiter = undefined
      set({ questions: undefined })
      waiter?.resolve(answer)
    },
  }
}
