import { Console } from 'node:console'
import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.js'
import { handleKey } from '../src/keys.js'
import { createStore } from '../src/store.js'

describe('store interaction flows', () => {
  it('folds session/event log batches and dedupes by seq', () => {
    const store = createStore()
    store.applySessionEvent({ log: [{ type: 'user/message', seq: 3, data: { message: { content: [{ type: 'text', text: '你好' }] } } }] })
    expect(store.state.items).toEqual([{ kind: 'user', id: '3', text: '你好' }])
    store.applySessionEvent({ log: [
      { type: 'user/message', seq: 3, data: { message: { content: [{ type: 'text', text: '你好' }] } } },
      { type: 'assistant/chunk', seq: 4, data: { chunk: { type: 'text-delta', text: '收到' } } },
    ] })
    expect(store.state.items).toHaveLength(2)
    expect(store.state.items[1]).toMatchObject({ kind: 'assistant', text: '收到' })
  })

  it('renders tool call cards to completion', () => {
    const store = createStore()
    store.applySessionEvent({ log: [
      { type: 'tool/call', seq: 1, data: { callId: 'c1', name: 'write', arguments: '{}' } },
      { type: 'tool/result', seq: 2, data: { callId: 'c1', meta: { summary: 'wrote file' } } },
    ] })
    expect(store.state.items).toEqual([
      { kind: 'tool', id: 'c1', name: 'write', args: '{}', done: true, summary: 'wrote file' },
    ])
  })

  it('holds typed draft and clears it', () => {
    const store = createStore()
    store.setDraft('hel')
    expect(store.state.draft).toBe('hel')
    store.setDraft('')
    expect(store.state.draft).toBe('')
  })

  it('renders interactive user message from data.content shape', () => {
    const store = createStore()
    store.applySessionEvent({ log: [{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: '只回复两个字:收到' }], source: { kind: 'user' } } }] })
    expect(store.state.items).toEqual([{ kind: 'user', id: '1', text: '只回复两个字:收到' }])
  })

  it('ignores runtime-context user messages', () => {
    const store = createStore()
    store.applySessionEvent({ log: [{ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'context' }], source: { kind: 'context' } } }] })
    expect(store.state.items).toHaveLength(0)
  })

  it('shows help as a system item', () => {
    const store = createStore()
    store.showHelp('帮助文本')
    expect(store.state.items).toEqual([{ kind: 'help', id: '0', text: '帮助文本' }])
  })

  it('resolves an approval prompt to the allowed outcome', async () => {
    const store = createStore()
    const pending = store.askApproval({ toolName: 'bash' })
    expect(store.state.approval?.toolName).toBe('bash')
    store.resolveApproval('allowed-once')
    await expect(pending).resolves.toBe('allowed-once')
    expect(store.state.approval).toBeUndefined()
  })

  it('resolves a question prompt with the typed answer', async () => {
    const store = createStore()
    const pending = store.askQuestions({ questions: [{ id: 'q1', question: '选哪个?' }] })
    expect(store.state.questions).toBeDefined()
    store.resolveQuestions({ answers: [{ id: 'q1', selected: [], custom: '第一个' }] })
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: '第一个' }] })
    expect(store.state.questions).toBeUndefined()
  })

  it('rejects a second approval request while the first is still pending', async () => {
    const store = createStore()
    const first = store.askApproval({ toolName: 'bash' })
    await expect(store.askApproval({ toolName: 'write' })).rejects.toThrow(/already pending/)
    expect(store.state.approval?.toolName).toBe('bash')
    store.resolveApproval('allowed-once')
    await expect(first).resolves.toBe('allowed-once')
    const next = store.askApproval({ toolName: 'write' })
    expect(store.state.approval?.toolName).toBe('write')
    store.resolveApproval('denied')
    await expect(next).resolves.toBe('denied')
  })

  it('rejects a second question request while the first is still pending', async () => {
    const store = createStore()
    const first = store.askQuestions({ questions: [{ id: 'q1', question: '选哪个?' }] })
    await expect(
      store.askQuestions({ questions: [{ id: 'q2', question: '再来一个?' }] }),
    ).rejects.toThrow(/already pending/)
    expect(store.state.questions?.request.questions[0]?.id).toBe('q1')
    store.resolveQuestions({ answers: [{ id: 'q1', selected: ['甲'] }] })
    await expect(first).resolves.toEqual({ answers: [{ id: 'q1', selected: ['甲'] }] })
  })

  describe('modal key routing (handleKey)', () => {
    function deps(store: ReturnType<typeof createStore>) {
      const sent: string[] = []
      return {
        deps: {
          store,
          onSend: (text: string) => sent.push(text),
          onCancel: () => {},
          onExit: () => {},
          showHelp: () => {},
          toggleThinking: () => {},
        },
        sent,
      }
    }

    it('free-text question: typed characters land in the draft and Enter resolves the answer', async () => {
      const store = createStore()
      const { deps: d, sent } = deps(store)
      const pending = store.askQuestions({ questions: [{ id: 'q1', question: '补充说明?' }] })
      handleKey(d, '第一个', {})
      expect(store.state.draft).toBe('第一个')
      handleKey(d, '', { return: true })
      await expect(pending).resolves.toEqual({
        answers: [{ id: 'q1', selected: [], custom: '第一个' }],
      })
      expect(store.state.questions).toBeUndefined()
      expect(sent).toEqual([])
    })

    it('question modal steals Enter: a pre-existing draft is submitted as the answer, not sent as chat', async () => {
      const store = createStore()
      store.setDraft('草稿')
      const { deps: d, sent } = deps(store)
      const pending = store.askQuestions({ questions: [{ id: 'q1', question: '确认?' }] })
      handleKey(d, '', { return: true })
      await expect(pending).resolves.toEqual({
        answers: [{ id: 'q1', selected: [], custom: '草稿' }],
      })
      expect(sent).toEqual([])
    })

    it('option question still selects by digit', async () => {
      const store = createStore()
      const { deps: d } = deps(store)
      const pending = store.askQuestions({
        questions: [{ id: 'q1', question: '选哪个?', options: [{ label: '甲' }, { label: '乙' }] }],
      })
      handleKey(d, '2', {})
      await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['乙'] }] })
    })

    it('approval modal answers y/n and ignores other keys', () => {
      const store = createStore()
      const { deps: d } = deps(store)
      store.askApproval({ toolName: 'bash' })
      handleKey(d, 'x', {})
      expect(store.state.approval).toBeDefined()
      handleKey(d, 'y', {})
      expect(store.state.approval).toBeUndefined()
    })

    it('plain chat Enter still sends when no modal is open', () => {
      const store = createStore()
      const { deps: d, sent } = deps(store)
      handleKey(d, '你好', {})
      handleKey(d, '', { return: true })
      expect(sent).toEqual(['你好'])
      expect(store.state.draft).toBe('')
    })

    it('supports backspace and DEL codepoint deletion in both chat and free-text question modes', async () => {
      const store = createStore()
      const { deps: d } = deps(store)
      handleKey(d, '你好🚀', {})
      handleKey(d, '', { backspace: true })
      expect(store.state.draft).toBe('你好')
      handleKey(d, '\x7f', {})
      expect(store.state.draft).toBe('你')
      handleKey(d, '\b', {})
      expect(store.state.draft).toBe('')

      const pending = store.askQuestions({ questions: [{ id: 'q1', question: '说明?' }] })
      handleKey(d, 'ab🚀', {})
      handleKey(d, '', { delete: true })
      expect(store.state.draft).toBe('ab')
      handleKey(d, '', { return: true })
      await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: 'ab' }] })
    })

    it('/exit invokes deps.onExit instead of calling process.exit directly', () => {
      const store = createStore()
      const base = deps(store)
      let exited = 0
      const d = {
        ...base.deps,
        onExit: () => {
          exited += 1
        },
      }
      handleKey(d, '/exit', {})
      handleKey(d, '', { return: true })
      expect(exited).toBe(1)
      expect(base.sent).toEqual([])
    })

    it('cleans up pending approval and question prompts when AbortSignal fires', async () => {
      const store = createStore()
      const ac1 = new AbortController()
      const approvalPromise = store.askApproval({ toolName: 'bash' }, ac1.signal)
      expect(store.state.approval).toBeDefined()
      ac1.abort()
      await expect(approvalPromise).resolves.toBe('cancelled')
      expect(store.state.approval).toBeUndefined()

      const ac2 = new AbortController()
      const questionPromise = store.askQuestions(
        { questions: [{ id: 'q-abort', question: '确定?' }], signal: ac2.signal },
      )
      expect(store.state.questions).toBeDefined()
      ac2.abort()
      await expect(questionPromise).rejects.toThrow(/aborted/i)
      expect(store.state.questions).toBeUndefined()
    })
  })

  it('folds todo/write, turn lifecycle, token usage, title, historical assistant/message, and tool error flags', () => {
    const store = createStore()
    store.applySessionEvent({
      log: [
        { type: 'session/title', seq: 1, data: { title: '架构重构' } },
        { type: 'session.model', seq: 2, data: { provider: 'deepseek', model: 'deepseek-reasoner' } },
        { type: 'turn/start', seq: 3, data: {} },
        {
          type: 'todo/write',
          seq: 4,
          data: {
            todos: [
              { id: 't1', content: '分析竞品', status: 'completed' },
              { id: 't2', content: '实现优化', status: 'in_progress' },
            ],
          },
        },
        { type: 'step/end', seq: 5, data: { usage: { inputTokens: 150, outputTokens: 40, cacheReadTokens: 25 } } },
        {
          type: 'assistant/message',
          seq: 6,
          data: {
            message: {
              content: [
                { type: 'thinking', thinking: '先检查回放队列' },
                { type: 'text', text: '历史回复已加载。' },
              ],
            },
          },
        },
        { type: 'tool/call', seq: 7, data: { callId: 'err1', name: 'bash', arguments: '{"cmd":"false"}' } },
        { type: 'tool/result', seq: 8, data: { callId: 'err1', isError: true, meta: { summary: 'exit 1' } } },
        { type: 'turn/end', seq: 9, data: { stopReason: 'interrupted' } },
      ],
    })

    expect(store.state.title).toBe('架构重构')
    expect(store.state.model).toBe('deepseek-reasoner')
    expect(store.state.status).toBe('idle')
    expect(store.state.todos).toHaveLength(2)
    expect(store.state.usage).toEqual({
      inputTokens: 150,
      outputTokens: 40,
      cacheReadTokens: 25,
      cacheWriteTokens: 0,
      turns: 1,
    })
    expect(store.state.items.some((i) => i.kind === 'assistant' && i.text === '历史回复已加载。' && i.reasoning === '先检查回放队列')).toBe(true)
    expect(store.state.items.some((i) => i.kind === 'tool' && i.id === 'err1' && i.isError === true)).toBe(true)
    expect(store.state.items.some((i) => i.kind === 'notice' && i.tone === 'warn' && i.text.includes('中断'))).toBe(true)

    // Next turn/start clears previous turn's todo checklist
    store.applySessionEvent({ log: [{ type: 'turn/start', seq: 10, data: {} }] })
    expect(store.state.todos).toEqual([])
    expect(store.state.status).toBe('running')
    expect(store.state.usage.turns).toBe(2)
  })

  it('handles /todos, /usage, /commands locally and recalls prompt history via Up/Down arrows', () => {
    const store = createStore()
    store.setCommands([{ name: 'compact', description: '压缩会话' }])
    store.applySessionEvent({
      log: [
        { type: 'turn/start', seq: 1, data: {} },
        { type: 'todo/write', seq: 2, data: { todos: [{ id: '1', content: 'Run check', status: 'in_progress' }] } },
        { type: 'step/end', seq: 3, data: { usage: { inputTokens: 80, outputTokens: 20 } } },
      ],
    })

    const sent: string[] = []
    const d = {
      store,
      onSend: (t: string) => sent.push(t),
      onCancel: () => {},
      onExit: () => {},
      showHelp: () => {},
      toggleThinking: () => {},
    }

    handleKey(d, 'first prompt', {})
    handleKey(d, '', { return: true })
    handleKey(d, 'second prompt', {})
    handleKey(d, '', { return: true })
    expect(sent).toEqual(['first prompt', 'second prompt'])

    // Up arrow cycles backwards, Down restores current draft
    handleKey(d, 'typing', {})
    handleKey(d, '', { upArrow: true })
    expect(store.state.draft).toBe('second prompt')
    handleKey(d, '', { upArrow: true })
    expect(store.state.draft).toBe('first prompt')
    handleKey(d, '', { downArrow: true })
    expect(store.state.draft).toBe('second prompt')
    handleKey(d, '', { downArrow: true })
    expect(store.state.draft).toBe('typing')

    store.setDraft('')
    for (const cmd of ['/todos', '/usage', '/commands']) {
      handleKey(d, cmd, {})
      handleKey(d, '', { return: true })
    }
    expect(sent).toEqual(['first prompt', 'second prompt'])
    expect(store.state.items.filter((i) => i.kind === 'help').map((i) => i.text).join('\n')).toContain('Run check')
    expect(store.state.items.filter((i) => i.kind === 'help').map((i) => i.text).join('\n')).toContain('/compact')
    expect(store.state.items.filter((i) => i.kind === 'help').map((i) => i.text).join('\n')).toContain('输入 80 / 输出 20')
  })

  it('supports multi-question progression, Esc cancellation, approval Y/N/Esc, /quit, Ctrl+C, and fatal exit', async () => {
    const store = createStore()
    let exits = 0
    const d = {
      store,
      onSend: () => {},
      onCancel: () => {},
      onExit: () => {
        exits += 1
      },
      showHelp: () => {},
      toggleThinking: () => {},
    }

    // Multi-question progression via option digits / keys
    const ac1 = new AbortController()
    const multiPromise = store.askQuestions({
      questions: [
        {
          id: 'q1',
          header: 'Framework',
          question: 'Pick framework',
          options: [{ label: 'Vitest' }, { label: 'Node test' }],
        },
        {
          id: 'q2',
          header: 'Scope',
          question: 'Pick scope',
          options: [{ label: 'Unit' }, { label: 'E2E' }],
        },
      ],
      signal: ac1.signal,
    })
    expect(store.state.questions?.currentIndex).toBe(0)
    handleKey(d, '1', {})
    expect(store.state.questions?.currentIndex).toBe(1)
    handleKey(d, '2', {})
    await expect(multiPromise).resolves.toEqual({
      answers: [
        { id: 'q1', selected: ['Vitest'] },
        { id: 'q2', selected: ['E2E'] },
      ],
    })
    expect(store.state.questions).toBeUndefined()

    // Esc cancels active question modal cleanly
    const ac2 = new AbortController()
    const cancelPromise = store.askQuestions({
      questions: [{ id: 'q3', header: 'Cancel', question: 'Confirm?', options: [{ label: 'Yes' }] }],
      signal: ac2.signal,
    })
    handleKey(d, '', { escape: true })
    await expect(cancelPromise).rejects.toThrow(/取消|cancel|abort/i)
    expect(store.state.questions).toBeUndefined()

    // Approval modal: 'x' stays ignored, 'y'/'n'/Esc resolve cleanly
    const ap1 = store.askApproval({ toolName: 'bash', callId: 'a1' }, new AbortController().signal)
    handleKey(d, 'x', {})
    expect(store.state.approval).toBeDefined()
    handleKey(d, 'y', {})
    await expect(ap1).resolves.toBe('allowed-once')

    const ap2 = store.askApproval({ toolName: 'bash', callId: 'a2' }, new AbortController().signal)
    handleKey(d, 'N', {})
    await expect(ap2).resolves.toBe('rejected')

    const ap3 = store.askApproval({ toolName: 'bash', callId: 'a3' }, new AbortController().signal)
    handleKey(d, '', { escape: true })
    await expect(ap3).resolves.toBe('rejected')

    // /quit and Ctrl+C trigger onExit
    handleKey(d, '/quit', {})
    handleKey(d, '', { return: true })
    expect(exits).toBe(1)

    handleKey(d, 'c', { ctrl: true })
    expect(exits).toBe(2)

    // Fatal screen exits on keypress
    store.setFatal('boot failed')
    handleKey(d, '', { return: true })
    expect(exits).toBe(3)
  })

  it('apply(ctx) registers waterfall listeners, never calls registerProvider, and reads commands via ctx.get', async () => {
    expect(name).toBe('dsh-community-tui')
    expect(inject).toEqual(['agents', 'userQuestions', 'agentDefaultModel', 'attachments'])

    const registeredHandlers = new Map<string, (req: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
    let listCalled = 0
    let disposed = 0

    const mockCommands = {
      list: () => {
        listCalled += 1
        return [{ name: 'compact', description: '压缩会话' }]
      },
    }

    const mockCtx = {
      get: (serviceName: string) => {
        if (serviceName === 'loader') return { await: async () => {} }
        if (serviceName === 'commands') return mockCommands
        return undefined
      },
      get commands() {
        throw new Error('cannot get property "commands" without inject')
      },
      userQuestions: {},
      attachments: {
        imageLimits: {
          maxImageBytes: 1024,
          maxImagesPerMessage: 4,
          maxMessageImageBytes: 4096,
          maxImagePixels: 10000,
          maxImageDimension: 1000,
          mediaTypes: ['image/png'],
        },
        saveImages: async () => [],
      },
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      },
      agents: {
        create: async () => ({
          agent: {
            id: 'agent-1',
            options: { model: 'deepseek-chat' },
            status: 'idle',
            whenIdle: async () => {},
            ctx: { on: () => {} },
            followup: () => {},
            cancel: () => {},
          },
          dispose: async () => {
            disposed += 1
          },
        }),
        resume: async () => {
          throw new Error('unexpected resume')
        },
      },
      on: (event: string, listener: (req: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
        registeredHandlers.set(event, listener)
        return () => {
          registeredHandlers.delete(event)
        }
      },
    }

    const prevOutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
    const prevInIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
    const prevSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode')
    const prevStdoutWrite = process.stdout.write.bind(process.stdout)
    const prevConsoleCtor = (console as unknown as { Console?: unknown }).Console
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    Object.defineProperty(process.stdin, 'setRawMode', { value: () => process.stdin, configurable: true })
    process.stdout.write = (() => true) as typeof process.stdout.write
    if (typeof prevConsoleCtor !== 'function') {
      ;(console as unknown as { Console?: unknown }).Console = Console
    }
    let cleanup: (() => void) | void
    try {
      cleanup = apply(mockCtx as never)
      await new Promise((resolve) => setTimeout(resolve, 30))

      expect(registeredHandlers.has('user-questions/request')).toBe(true)
      expect(registeredHandlers.has('approval/request')).toBe(true)
      expect(listCalled).toBe(1)

      // Different agent's user-question falls through to next()
      let nextCalled = 0
      const uqHandler = registeredHandlers.get('user-questions/request')!
      await expect(
        uqHandler({ agent: { id: 'other-agent' }, questions: [] }, async () => {
          nextCalled += 1
          return { answers: [] }
        }),
      ).resolves.toEqual({ answers: [] })
      expect(nextCalled).toBe(1)
    } finally {
      cleanup?.()
      await new Promise((resolve) => setTimeout(resolve, 10))
      process.stdout.write = prevStdoutWrite
      if (prevConsoleCtor !== undefined) {
        ;(console as unknown as { Console?: unknown }).Console = prevConsoleCtor
      } else {
        delete (console as unknown as { Console?: unknown }).Console
      }
      if (prevInIsTTY) Object.defineProperty(process.stdin, 'isTTY', prevInIsTTY)
      else delete (process.stdin as { isTTY?: boolean }).isTTY
      if (prevSetRawMode) Object.defineProperty(process.stdin, 'setRawMode', prevSetRawMode)
      else delete (process.stdin as { setRawMode?: unknown }).setRawMode
      if (prevOutIsTTY) {
        Object.defineProperty(process.stdout, 'isTTY', prevOutIsTTY)
      } else {
        delete (process.stdout as { isTTY?: boolean }).isTTY
      }
    }
    expect(disposed).toBe(1)
  })
})
