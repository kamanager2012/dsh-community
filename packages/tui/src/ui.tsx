/**
 * Ink UI for the community terminal surface. Our own layout and components.
 */

import { Box, Text, useInput, useApp } from 'ink'
import { createElement, useState, useSyncExternalStore, type FC } from 'react'
import type { UiItem, UiStore } from './store.js'

interface AppProps {
  readonly store: UiStore
  readonly onSend: (text: string) => void
  readonly onCancel: () => void
  readonly onExit: () => void
}

const MUTED = '#6d7686'
const ACCENT = '#6ea8fe'
const TEXT = '#d9dee8'

function renderItem(item: UiItem, thinkingOpen: boolean): ReturnType<typeof createElement> {
  if (item.kind === 'help') {
    return createElement(Box, { key: item.id, borderStyle: 'round', borderColor: MUTED, flexDirection: 'column', paddingX: 1, marginBottom: 1 },
      createElement(Text, { color: MUTED }, item.text),
    )
  }
  if (item.kind === 'user') {
    return createElement(Box, { key: item.id, flexDirection: 'column', marginBottom: 1 },
      createElement(Text, { color: ACCENT, bold: true }, '你'),
      createElement(Text, null, item.text),
    )
  }
  if (item.kind === 'tool') {
    const args = item.args === '' ? '' : ` ${item.args.slice(0, 120)}`
    return createElement(Box, { key: item.id, marginBottom: 1 },
      createElement(Text, { color: item.done ? MUTED : '#e2c07a' },
        item.done ? `✓ ${item.name} — ${item.summary}` : `⚙ ${item.name}${args}`),
    )
  }
  const reasoning = thinkingOpen
    ? createElement(Text, { color: MUTED }, item.reasoning)
    : item.reasoning !== ''
      ? createElement(Text, { color: MUTED }, `思考 ${item.reasoning.length} 字 · Tab 展开`)
      : null
  return createElement(Box, { key: item.id, flexDirection: 'column', marginBottom: 1 },
    createElement(Text, { color: '#8fbc8f', bold: true }, '助手'),
    reasoning,
    createElement(Text, null, item.text),
  )
}

const Transcript: FC<{ store: UiStore; thinkingOpen: boolean }> = ({ store, thinkingOpen }) => {
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  if (state.fatal !== undefined) {
    return createElement(Text, { color: 'red' }, `启动失败：${state.fatal}`)
  }
  return createElement(Box, { flexDirection: 'column' },
    ...state.items.map((item) => renderItem(item, thinkingOpen)),
    state.status === 'running'
      ? createElement(Text, { color: MUTED }, '…')
      : null,
  )
}

const HELP_TEXT = `dsh-community-tui 帮助
  /help   显示本帮助
  /exit   退出
  Esc     打断当前回答
  Tab     展开/折叠思考过程
  y/n     审批弹窗:允许一次/拒绝
  数字键  提问弹窗:选择选项`

const InputBar: FC<{ store: UiStore }> = ({ store }) => {
  const draft = useSyncExternalStore(store.subscribe, () => store.state.draft)
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  if (state.approval !== undefined || state.questions !== undefined) return null
  if (draft === '') {
    return createElement(Text, { color: MUTED }, '输入任务，回车发送（/help /exit）')
  }
  return createElement(Text, null, '> ', draft, createElement(Text, { color: MUTED }, '█'))
}

const StatusBar: FC<{ store: UiStore }> = ({ store }) => {
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  return createElement(Text, { color: MUTED }, `dsh-community-tui · ${state.model} · ${state.status}`)
}

const ApprovalView: FC<{ store: UiStore }> = ({ store }) => {
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  const approval = state.approval
  if (approval === undefined) return null
  return createElement(Box, { borderStyle: 'round', borderColor: 'yellow', flexDirection: 'column', padding: 1 },
    createElement(Text, { bold: true, color: 'yellow' }, `审批：${approval.toolName}`),
    approval.reason !== undefined && approval.reason !== ''
      ? createElement(Text, { color: MUTED }, approval.reason)
      : null,
    createElement(Text, null, 'y=允许一次  n=拒绝'),
  )
}

const QuestionsView: FC<{ store: UiStore }> = ({ store }) => {
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  const draft = state.draft
  const questions = state.questions
  if (questions === undefined) return null
  const question = questions.request.questions[0]
  if (question === undefined) return null
  const options = question.options ?? []
  return createElement(Box, { borderStyle: 'round', borderColor: ACCENT, flexDirection: 'column', padding: 1 },
    createElement(Text, { bold: true, color: ACCENT }, `提问：${question.header ?? question.question}`),
    options.length > 0
      ? createElement(Text, null, options.map((option, index) => `${String(index + 1)}. ${option.label}`).join('  '))
      : createElement(Text, null, draft === '' ? '输入答案后回车' : `> ${draft}█`),
    options.length > 0
      ? createElement(Text, null, '输入编号回车')
      : null,
  )
}

export const App: FC<AppProps> = ({ store, onSend, onCancel, onExit }) => {
  const { exit } = useApp()
  const [thinkingOpen, setThinkingOpen] = useState(false)
  useInput((input, key) => {
    const raw = typeof input === 'string' ? input : ''
    const list = key.return ? ['\r'] : [...raw].map((ch) => ch === '\n' ? '\r' : ch)
    for (const ch of list) {
      const state = store.state
      if (ch === '\r') {
        const trimmed = state.draft.trim()
        store.setDraft('')
        if (trimmed === '/exit') process.exit(0)
        else if (trimmed === '/help') store.showHelp(HELP_TEXT)
        else if (trimmed !== '') onSend(trimmed)
        continue
      }
      if (state.approval !== undefined) {
        if (ch === 'y') store.resolveApproval('allowed-once')
        else if (ch === 'n') store.resolveApproval('rejected')
        continue
      }
      if (state.questions !== undefined) {
        const question = state.questions.request.questions[0]
        if (question !== undefined) {
          const options = question.options ?? []
          if (options.length > 0) {
            const index = Number(ch) - 1
            if (Number.isInteger(index) && index >= 0 && index < options.length) {
              store.resolveQuestions({ answers: [{ id: question.id, selected: [options[index]!.label] }] })
            }
          } else if (ch === '\r') {
            const answer = state.draft.trim()
            store.setDraft('')
            store.resolveQuestions({ answers: [{ id: question.id, selected: [], ...(answer === '' ? {} : { custom: answer }) }] })
          }
        }
        continue
      }
      if (ch === '\t') {
        setThinkingOpen((open) => !open)
        continue
      }
      if (ch === '\x1b' || key.escape) {
        onCancel()
        continue
      }
      if (ch === 'q' && key.ctrl) onExit()
      if (ch >= ' ' && ch !== '\x7f') store.setDraft(state.draft + ch)
    }
  })

  return createElement(Box, { flexDirection: 'column', padding: 1 },
    createElement(Transcript, { store, thinkingOpen }),
    createElement(ApprovalView, { store }),
    createElement(QuestionsView, { store }),
    createElement(Box, { marginTop: 1 },
      createElement(InputBar, { store }),
    ),
    createElement(StatusBar, { store }),
  )
}
