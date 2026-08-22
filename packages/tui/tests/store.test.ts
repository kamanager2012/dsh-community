import { describe, expect, it } from 'vitest'
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
  })
})
