import type { UserQuestionAnswer, UserQuestionRequest } from './types.ts'

export type UiItem =
  | { readonly kind: 'help'; readonly id: string; readonly text: string }
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'assistant'; readonly id: string; readonly text: string; readonly reasoning: string; readonly final: boolean }
  | { readonly kind: 'tool'; readonly id: string; readonly name: string; readonly args: string; readonly done: boolean; readonly summary: string }

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
  readonly approval: ApprovalPrompt | undefined
  readonly questions: QuestionPrompt | undefined
  readonly fatal: string | undefined
}

const EMPTY: UiState = {
  draft: '',
  items: [],
  status: 'idle',
  model: 'default',
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
  setFatal(message: string): void
  setDraft(text: string): void
  showHelp(text: string): void
  askApproval(prompt: ApprovalPrompt): Promise<string>
  resolveApproval(outcome: string): void
  askQuestions(request: UserQuestionRequest): Promise<UserQuestionAnswer>
  resolveQuestions(answer: UserQuestionAnswer): void
}

export function createStore(): UiStore {
  let state: UiState = EMPTY
  let lastSeq = -1
  const listeners = new Set<() => void>()
  let approvalWaiter: ((outcome: string) => void) | undefined
  let questionWaiter: ((answer: UserQuestionAnswer) => void) | undefined

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

    if (type === 'user/message') {
      const message = data.message !== undefined && typeof data.message === 'object'
        ? data.message as Record<string, unknown>
        : data
      const source = message.source
      if (typeof source === 'object' && source !== null && (source as { kind?: unknown }).kind !== 'user') return
      const text = displayOfBlocks(message.content)
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
      patchLast('assistant', (item) => item.kind === 'assistant' ? { ...item, final: true } : item)
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
      set({
        items: state.items.map((item) =>
          item.kind === 'tool' && item.id === callId ? { ...item, done: true, summary } : item,
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
    setFatal(message) {
      set({ fatal: message })
    },
    setDraft(text) {
      set({ draft: text })
    },
    showHelp(text) {
      set({ items: [...state.items, { kind: 'help', id: String(state.items.length), text }] })
    },
    askApproval(prompt) {
      if (approvalWaiter !== undefined) {
        return Promise.reject(
          new Error('an approval prompt is already pending; resolve it before requesting another'),
        )
      }
      set({ approval: prompt })
      return new Promise<string>((resolve) => {
        approvalWaiter = resolve
      })
    },
    resolveApproval(outcome) {
      set({ approval: undefined })
      approvalWaiter?.(outcome)
      approvalWaiter = undefined
    },
    askQuestions(request) {
      if (questionWaiter !== undefined) {
        return Promise.reject(
          new Error('a question prompt is already pending; answer it before requesting another'),
        )
      }
      set({ questions: { request } })
      return new Promise<UserQuestionAnswer>((resolve) => {
        questionWaiter = resolve
      })
    },
    resolveQuestions(answer) {
      set({ questions: undefined })
      questionWaiter?.(answer)
      questionWaiter = undefined
    },
  }
}
