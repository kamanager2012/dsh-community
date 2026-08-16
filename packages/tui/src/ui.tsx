/**
 * Ink UI for the community terminal surface. Our own layout and components.
 */

import { Box, Text, useInput, useApp } from 'ink'
import TextInput from 'ink-text-input'
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

function renderItem(item: UiItem): ReturnType<typeof createElement> {
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
  return createElement(Box, { key: item.id, flexDirection: 'column', marginBottom: 1 },
    createElement(Text, { color: '#8fbc8f', bold: true }, '助手'),
    item.reasoning !== '' ? createElement(Text, { color: MUTED }, item.reasoning) : null,
    createElement(Text, null, item.text),
  )
}

const Transcript: FC<{ store: UiStore }> = ({ store }) => {
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  if (state.fatal !== undefined) {
    return createElement(Text, { color: 'red' }, `启动失败：${state.fatal}`)
  }
  return createElement(Box, { flexDirection: 'column' },
    ...state.items.map((item) => renderItem(item)),
    state.status === 'running'
      ? createElement(Text, { color: MUTED }, '…')
      : null,
  )
}

const InputBar: FC<{ store: UiStore; onSend: (text: string) => void }> = ({ store, onSend }) => {
  const [value, setValue] = useState('')
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  if (state.approval !== undefined || state.questions !== undefined) return null
  return createElement(TextInput, {
    value,
    onChange: setValue,
    onSubmit: (text) => {
      const trimmed = text.trim()
      setValue('')
      if (trimmed === '/exit') process.exit(0)
      else if (trimmed !== '') onSend(trimmed)
    },
    placeholder: '输入任务，回车发送（/help /exit）',
  })
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
  const [text, setText] = useState('')
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  const questions = state.questions
  if (questions === undefined) return null
  const question = questions.request.questions[0]
  if (question === undefined) return null
  const options = question.options ?? []
  return createElement(Box, { borderStyle: 'round', borderColor: ACCENT, flexDirection: 'column', padding: 1 },
    createElement(Text, { bold: true, color: ACCENT }, `提问：${question.header ?? question.question}`),
    options.length > 0
      ? createElement(Text, null, options.map((option, index) => `${String(index + 1)}. ${option.label}`).join('  '))
      : createElement(TextInput, {
          value: text,
          onChange: setText,
          onSubmit: (answer) => {
            store.resolveQuestions({ answers: [{ id: question.id, selected: [], ...(answer.trim() === '' ? {} : { custom: answer.trim() }) }] })
            setText('')
          },
          placeholder: '输入答案后回车',
        }),
    options.length > 0
      ? createElement(Text, null, '输入编号回车')
      : null,
  )
}

export const App: FC<AppProps> = ({ store, onSend, onCancel, onExit }) => {
  const { exit } = useApp()
  useInput((input, key) => {
    const state = store.state
    if (state.approval !== undefined) {
      if (input === 'y') store.resolveApproval('allowed-once')
      else if (input === 'n') store.resolveApproval('rejected')
      return
    }
    if (state.questions !== undefined) {
      const question = state.questions.request.questions[0]
      if (question !== undefined && key.return === false) {
        const options = question.options ?? []
        const index = Number(input) - 1
        if (options.length > 0 && Number.isInteger(index) && index >= 0 && index < options.length) {
          store.resolveQuestions({ answers: [{ id: question.id, selected: [options[index]!.label] }] })
        }
      }
      return
    }
    if (key.escape) onCancel()
    if (input === 'q' && key.ctrl) onExit()
    if (input === '?' ) {
      // help hint rendered inline via placeholder; keep minimal
    }
  })

  return createElement(Box, { flexDirection: 'column', padding: 1 },
    createElement(Transcript, { store }),
    createElement(ApprovalView, { store }),
    createElement(QuestionsView, { store }),
    createElement(Box, { marginTop: 1 },
      createElement(InputBar, { store, onSend }),
    ),
    createElement(StatusBar, { store }),
  )
}
