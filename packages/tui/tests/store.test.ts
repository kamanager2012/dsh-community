import { describe, expect, it } from 'vitest'
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
})
