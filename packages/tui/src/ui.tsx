/**
 * Ink UI for the community terminal surface. Our own layout and components.
 */

import { Box, Text, useInput } from 'ink'
import { createElement, useState, useSyncExternalStore, type FC } from 'react'
import { handleKey } from './keys.js'
import { renderMarkdownToAnsi, stripUnsafeTerminalControls } from './markdown.js'
import type { UiItem, UiStore } from './store.js'
import { inspectLocalGitDiff, listLocalWorkspaceFiles, parseDiffCommandArgs } from './workspace.js'

interface AppProps {
  readonly store: UiStore
  readonly dualBadge: string
  readonly onSend: (text: string) => void
  readonly onCancel: () => void
  readonly onExit: () => void
  readonly cwd?: string
}

const MUTED = '#6d7686'
const ACCENT = '#6ea8fe'

function safeText(raw: string): string {
  return stripUnsafeTerminalControls(raw)
}

function renderItem(item: UiItem, thinkingOpen: boolean): ReturnType<typeof createElement> {
  if (item.kind === 'help') {
    return createElement(Box, { key: item.id, borderStyle: 'round', borderColor: MUTED, flexDirection: 'column', paddingX: 1, marginBottom: 1 },
      createElement(Text, { color: MUTED }, safeText(item.text)),
    )
  }
  if (item.kind === 'notice') {
    const toneColor = item.tone === 'error' ? 'red' : item.tone === 'warn' ? 'yellow' : ACCENT
    return createElement(Box, { key: item.id, marginBottom: 1 },
      createElement(Text, { color: toneColor }, `• ${safeText(item.text)}`),
    )
  }
  if (item.kind === 'user') {
    return createElement(Box, { key: item.id, flexDirection: 'column', marginBottom: 1 },
      createElement(Text, { color: ACCENT, bold: true }, '你'),
      createElement(Text, null, safeText(item.text)),
    )
  }
  if (item.kind === 'tool') {
    const args = item.args === '' ? '' : ` ${safeText(item.args.slice(0, 120))}`
    const name = safeText(item.name)
    const summary = safeText(item.summary)
    const color = item.isError ? 'red' : item.done ? MUTED : '#e2c07a'
    const marker = item.isError ? '✗' : item.done ? '✓' : '⚙'
    return createElement(Box, { key: item.id, marginBottom: 1 },
      createElement(Text, { color },
        item.done ? `${marker} ${name} — ${summary}` : `⚙ ${name}${args}`),
    )
  }
  const reasoning = thinkingOpen
    ? createElement(Text, { color: MUTED }, safeText(item.reasoning))
    : item.reasoning !== ''
      ? createElement(Text, { color: MUTED }, `思考 ${item.reasoning.length} 字 · Tab 展开`)
      : null
  return createElement(Box, { key: item.id, flexDirection: 'column', marginBottom: 1 },
    createElement(Text, { color: '#8fbc8f', bold: true }, '助手'),
    reasoning,
    createElement(Text, null, renderMarkdownToAnsi(item.text)),
  )
}

const Transcript: FC<{ store: UiStore; thinkingOpen: boolean }> = ({ store, thinkingOpen }) => {
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  if (state.fatal !== undefined) {
    return createElement(Box, { flexDirection: 'column', marginBottom: 1 },
      createElement(Text, { color: 'red', wrap: 'wrap' }, `启动失败：${safeText(state.fatal)}`),
      createElement(Text, { color: MUTED, wrap: 'wrap' }, '按 Enter / Esc / Ctrl+C 退出'),
    )
  }
  return createElement(Box, { flexDirection: 'column' },
    ...state.items.map((item) => renderItem(item, thinkingOpen)),
    state.status === 'booting'
      ? createElement(Text, { color: MUTED }, '正在初始化官方运行时…')
      : state.status === 'running'
        ? createElement(Text, { color: MUTED }, '…')
        : null,
  )
}

const HELP_TEXT = `dsh-community-tui 帮助
  /help     显示本帮助
  /commands 查看官方斜杠命令
  /diff     查看本地 Git 变更（/diff [path] [--staged]）
  /todos    查看当前任务清单
  /usage    查看会话状态与 Token 用量
  /exit     退出（同 /quit 或 Ctrl+C / Ctrl+Q）
  /image "图1.png" ["图2.webp"] -- 可选提示词
            图片先交给官方 attachment store 校验/规范化/持久化
  @path     输入 @ 触发文件补全，↑/↓ 切换，Tab 补全，Esc 收起
  ↑/↓       浏览历史输入
  Esc       打断回答 / 拒绝审批 / 取消提问
  Tab       补全 @file 候选，否则展开/折叠思考过程
  y/n       审批弹窗:允许一次/拒绝
  数字键    提问弹窗:选择选项`

const TodosPanel: FC<{ store: UiStore }> = ({ store }) => {
  const todos = useSyncExternalStore(store.subscribe, () => store.state.todos)
  if (todos.length === 0) return null
  const doneCount = todos.filter((t) => t.status === 'completed' || t.status === 'done').length
  return createElement(Box, { borderStyle: 'round', borderColor: MUTED, flexDirection: 'column', paddingX: 1, marginBottom: 1 },
    createElement(Text, { color: ACCENT, bold: true }, `任务进度 ${doneCount}/${todos.length}`),
    ...todos.slice(0, 8).map((todo, idx) => {
      const marker = todo.status === 'completed' || todo.status === 'done'
        ? '✓'
        : todo.status === 'in_progress'
          ? '▶'
          : '○'
      return createElement(Text, { key: todo.id ?? String(idx), color: todo.status === 'in_progress' ? '#e2c07a' : MUTED },
        `${marker} ${safeText(todo.content)}`)
    }),
  )
}

const InputBar: FC<{ store: UiStore }> = ({ store }) => {
  const draft = useSyncExternalStore(store.subscribe, () => store.state.draft)
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  if (state.fatal !== undefined || state.approval !== undefined || state.questions !== undefined) return null
  if (draft === '') {
    return createElement(Text, { color: MUTED, wrap: 'wrap' }, '输入任务，回车发送（@file /help /diff /commands /todos /usage /image /exit）')
  }
  return createElement(Text, { wrap: 'wrap' }, '> ', safeText(draft), createElement(Text, { color: MUTED }, '█'))
}

const AtFileBar: FC<{ store: UiStore }> = ({ store }) => {
  const comp = useSyncExternalStore(store.subscribe, () => store.state.atCompletion)
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  if (
    comp === undefined
    || comp.matches.length === 0
    || state.fatal !== undefined
    || state.approval !== undefined
    || state.questions !== undefined
  ) {
    return null
  }
  return createElement(Box, { borderStyle: 'round', borderColor: ACCENT, flexDirection: 'column', paddingX: 1, marginTop: 1 },
    createElement(Text, { color: ACCENT, bold: true }, `工作区文件补全 @${safeText(comp.query)}（↑/↓ 选择 · Tab 补全 · Esc 收起）`),
    ...comp.matches.slice(0, 8).map((file, idx) => {
      const selected = idx === comp.selectedIndex
      return createElement(Text, { key: file, color: selected ? ACCENT : MUTED, bold: selected },
        `${selected ? '▶ ' : '  '}${safeText(file)}`)
    }),
  )
}

const StatusBar: FC<{ store: UiStore; dualBadge: string }> = ({ store, dualBadge }) => {
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  const totalTok = state.usage.inputTokens + state.usage.outputTokens + state.usage.cacheReadTokens + state.usage.cacheWriteTokens
  const parts = [
    ...(state.title ? [safeText(state.title)] : []),
    safeText(state.model),
    safeText(state.status),
    ...(totalTok > 0 ? [`tok ${totalTok} (${state.usage.inputTokens}↑/${state.usage.outputTokens}↓)`] : []),
    ...(state.usage.turns > 0 ? [`${state.usage.turns}轮`] : []),
  ]
  return createElement(Box, { flexDirection: 'column', marginTop: 1 },
    createElement(Text, { color: MUTED, wrap: 'wrap' }, safeText(dualBadge)),
    createElement(Text, { color: MUTED }, parts.join(' · ')),
  )
}

const ApprovalView: FC<{ store: UiStore }> = ({ store }) => {
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  const approval = state.approval
  if (approval === undefined) return null
  return createElement(Box, { borderStyle: 'round', borderColor: 'yellow', flexDirection: 'column', padding: 1 },
    createElement(Text, { bold: true, color: 'yellow', wrap: 'wrap' }, `审批：${safeText(approval.toolName)}`),
    approval.reason !== undefined && approval.reason !== ''
      ? createElement(Text, { color: MUTED, wrap: 'wrap' }, safeText(approval.reason))
      : null,
    createElement(Text, { wrap: 'wrap' }, 'y=允许一次  n/Esc=拒绝'),
  )
}

const QuestionsView: FC<{ store: UiStore }> = ({ store }) => {
  const state = useSyncExternalStore(store.subscribe, () => store.state)
  const draft = state.draft
  const questions = state.questions
  if (questions === undefined) return null
  const total = questions.request.questions.length
  const currentIndex = questions.currentIndex
  const question = questions.request.questions[currentIndex]
  if (question === undefined) return null
  const options = question.options ?? []
  const progress = total > 1 ? ` (${String(currentIndex + 1)}/${String(total)})` : ''
  return createElement(Box, { borderStyle: 'round', borderColor: ACCENT, flexDirection: 'column', padding: 1 },
    createElement(Text, { bold: true, color: ACCENT, wrap: 'wrap' }, `提问${progress}：${safeText(question.header ?? question.question)}`),
    question.header !== undefined && question.header !== '' && question.header !== question.question
      ? createElement(Text, { color: MUTED, wrap: 'wrap' }, safeText(question.question))
      : null,
    options.length > 0
      ? createElement(Text, { wrap: 'wrap' }, options.map((option, index) => `${String(index + 1)}. ${safeText(option.label)}${option.description ? ` (${safeText(option.description)})` : ''}`).join('  '))
      : createElement(Text, { wrap: 'wrap' }, draft === '' ? '输入答案后回车 · Esc 取消' : `> ${safeText(draft)}█`),
    options.length > 0
      ? createElement(Text, { color: MUTED, wrap: 'wrap' }, '输入编号选择 · Esc 取消')
      : null,
  )
}

export const App: FC<AppProps> = ({ store, dualBadge, onSend, onCancel, onExit, cwd }) => {
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const workspaceRoot = cwd ?? process.cwd()
  useInput((input, key) => {
    handleKey({
      store,
      onSend,
      onCancel,
      onExit,
      showHelp: () => store.showHelp(HELP_TEXT),
      toggleThinking: () => setThinkingOpen((open) => !open),
      inspectDiff: async (argText) => {
        const parsed = parseDiffCommandArgs(argText)
        if ('error' in parsed) {
          store.showNotice(parsed.error, 'warn')
          return
        }
        const res = await inspectLocalGitDiff(workspaceRoot, parsed)
        if (res.ok) store.showHelp(res.output)
        else store.showNotice(res.error, 'warn')
      },
      completeAtFiles: (query) => listLocalWorkspaceFiles(workspaceRoot, { query, limit: 8 }),
    }, typeof input === 'string' ? input : '', key)
  })

  return createElement(Box, { flexDirection: 'column', padding: 1 },
    createElement(Transcript, { store, thinkingOpen }),
    createElement(TodosPanel, { store }),
    createElement(ApprovalView, { store }),
    createElement(QuestionsView, { store }),
    createElement(Box, { marginTop: 1 },
      createElement(InputBar, { store }),
    ),
    createElement(AtFileBar, { store }),
    createElement(StatusBar, { store, dualBadge }),
  )
}
