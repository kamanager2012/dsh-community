import type { UiStore } from './store.js'
import { extractTrailingAtQuery } from './workspace.js'

/**
 * Pure key handling for the terminal surface, split out of the Ink component
 * so modal routing is unit-testable without a renderer.
 *
 * Modal state (approval / questions) is checked BEFORE plain chat Enter.
 * Otherwise a question prompt swallows every character and its Enter is
 * stolen as a chat message — the free-text answer path becomes unusable.
 */
export interface KeyEvent {
  readonly return?: boolean
  readonly escape?: boolean
  readonly ctrl?: boolean
  readonly tab?: boolean
  readonly backspace?: boolean
  readonly delete?: boolean
  readonly upArrow?: boolean
  readonly downArrow?: boolean
}

export interface KeyHandlerDeps {
  readonly store: UiStore
  readonly onSend: (text: string) => void
  readonly onCancel: () => void
  readonly onExit: () => void
  readonly showHelp: () => void
  readonly toggleThinking: () => void
  readonly inspectDiff?: (argText: string) => void | Promise<void>
  readonly completeAtFiles?: (query: string) => readonly string[] | Promise<readonly string[]>
}

const atQueryGenByStore = new WeakMap<UiStore, number>()

function nextAtQueryGen(store: UiStore): number {
  const next = (atQueryGenByStore.get(store) ?? 0) + 1
  atQueryGenByStore.set(store, next)
  return next
}

function stageDraftUpdate(store: KeyHandlerDeps['store'], nextDraft: string): void {
  store.setDraft(nextDraft)
  nextAtQueryGen(store)
  // Clear candidates for any prior query so Tab cannot accept stale results while coalescing/lookup runs.
  if (store.state.atCompletion !== undefined) {
    store.setAtCompletion(undefined)
  }
}

function refreshAtFileCompletion(deps: KeyHandlerDeps): void {
  const { store } = deps
  const targetDraft = store.state.draft
  const match = extractTrailingAtQuery(targetDraft)
  if (!match || !deps.completeAtFiles) {
    nextAtQueryGen(store)
    if (store.state.atCompletion !== undefined) store.setAtCompletion(undefined)
    return
  }

  const gen = nextAtQueryGen(store)
  const publish = (matches: readonly string[]): void => {
    const cur = store.state
    if (
      atQueryGenByStore.get(store) !== gen
      || cur.draft !== targetDraft
      || cur.fatal !== undefined
      || cur.approval !== undefined
      || cur.questions !== undefined
    ) {
      return
    }
    if (matches.length === 0) {
      if (cur.atCompletion !== undefined) store.setAtCompletion(undefined)
      return
    }
    store.setAtCompletion({
      query: match.query,
      atIndex: match.atIndex,
      matches: [...matches],
      selectedIndex: 0,
    })
  }

  const res = deps.completeAtFiles(match.query)
  if (Array.isArray(res)) {
    publish(res)
  } else {
    void Promise.resolve(res).then(publish, () => {
      if (atQueryGenByStore.get(store) === gen && store.state.atCompletion !== undefined) {
        store.setAtCompletion(undefined)
      }
    })
  }
}

function dropLastCodePoint(text: string): string {
  const chars = [...text]
  chars.pop()
  return chars.join('')
}

/** Handle one useInput callback (one keypress, possibly several characters). */
export function handleKey(deps: KeyHandlerDeps, raw: string, key: KeyEvent = {}): void {
  const list = key.return
    ? ['\r']
    : (raw === '' && key.tab)
      ? ['\t']
      : (raw === '' && (key.backspace || key.delete))
        ? ['\x7f']
        : (raw === '' && (key.upArrow || key.downArrow))
          ? ['']
          : (raw === '' && key.escape)
            ? ['\x1b']
            : [...raw].map((ch) => ch === '\n' ? '\r' : ch)
  let needsCompletionRefresh = false
  for (const ch of list) {
    // Coalesce @file lookups across whole input/paste chunks and skip lookups cancelled before chunk end.
    needsCompletionRefresh = applyChar(deps, ch, key)
  }
  if (needsCompletionRefresh) {
    refreshAtFileCompletion(deps)
  }
}

function applyChar(deps: KeyHandlerDeps, ch: string, key: KeyEvent): boolean {
  const { store } = deps
  const state = store.state

  if (ch === '\x03' || (key.ctrl && (ch === 'c' || ch === 'C' || ch === 'q' || ch === 'Q'))) {
    deps.onExit()
    return false
  }

  if (state.fatal !== undefined) {
    if (ch === '\r' || ch === '\x1b' || key.escape || ch === 'q' || ch === 'Q') {
      deps.onExit()
    }
    return false
  }

  if (state.approval !== undefined) {
    if (ch === 'y' || ch === 'Y') store.resolveApproval('allowed-once')
    else if (ch === 'n' || ch === 'N' || ch === '\x1b' || key.escape) store.resolveApproval('rejected')
    return false
  }

  if (state.questions !== undefined) {
    if (ch === '\x1b' || key.escape) {
      store.cancelQuestions()
      return false
    }
    const question = state.questions.request.questions[state.questions.currentIndex]
    if (question === undefined) return false
    const options = question.options ?? []
    if (options.length > 0) {
      const index = Number(ch) - 1
      if (Number.isInteger(index) && index >= 0 && index < options.length) {
        store.submitCurrentQuestionAnswer({ id: question.id, selected: [options[index]!.label] })
      }
      return false
    }
    if (ch === '\r') {
      const answer = state.draft.trim()
      store.setDraft('')
      store.submitCurrentQuestionAnswer({
        id: question.id,
        selected: [],
        ...(answer === '' ? {} : { custom: answer }),
      })
      return false
    }
    if (ch === '\x7f' || ch === '\b') {
      store.setDraft(dropLastCodePoint(state.draft))
      return false
    }
    if (ch >= ' ' && ch !== '\x7f') store.setDraft(state.draft + ch)
    return false
  }

  if (ch === '\r') {
    const trimmed = state.draft.trim()
    nextAtQueryGen(store)
    if (state.atCompletion !== undefined) store.setAtCompletion(undefined)
    store.setDraft('')
    if (trimmed === '/exit' || trimmed === '/quit') deps.onExit()
    else if (trimmed === '/help') deps.showHelp()
    else if (trimmed === '/diff' || trimmed.startsWith('/diff ')) {
      if (deps.inspectDiff) {
        void Promise.resolve(deps.inspectDiff(trimmed.slice(5).trim())).catch((err) => {
          store.showNotice(`/diff 执行失败：${err instanceof Error ? err.message : String(err)}`, 'error')
        })
      } else {
        store.showNotice('当前会话未启用 /diff 检查', 'warn')
      }
    } else if (trimmed === '/todos') {
      const lines = state.todos.length === 0
        ? ['暂无待办任务']
        : state.todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`)
      store.showHelp(`待办清单（${state.todos.length}）：\n  ${lines.join('\n  ')}`)
    } else if (trimmed === '/usage' || trimmed === '/status') {
      const u = state.usage
      const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens
      store.showHelp(
        `会话状态：${state.title ?? '未命名'} · 模型：${state.model} · 状态：${state.status}\n` +
        `用量统计：输入 ${u.inputTokens} / 输出 ${u.outputTokens} / 缓存读 ${u.cacheReadTokens} / 总计 ${total} · 回合 ${u.turns}`,
      )
    } else if (trimmed === '/commands') {
      const listText = state.commands.length === 0
        ? '当前未加载扩展斜杠命令'
        : state.commands.map((c) => `/${c.name}${c.inputHint ? ` ${c.inputHint}` : ''} — ${c.description}`).join('\n  ')
      store.showHelp(`可用官方斜杠命令：\n  ${listText}`)
    } else if (trimmed !== '') {
      store.recordPrompt(trimmed)
      deps.onSend(trimmed)
    }
    return false
  }
  if (key.upArrow && ch === '') {
    if (state.atCompletion && state.atCompletion.matches.length > 0) {
      store.moveAtCompletionSelection(-1)
      return false
    }
    store.recallPreviousPrompt()
    return false
  }
  if (key.downArrow && ch === '') {
    if (state.atCompletion && state.atCompletion.matches.length > 0) {
      store.moveAtCompletionSelection(1)
      return false
    }
    store.recallNextPrompt()
    return false
  }
  if (ch === '\x7f' || ch === '\b') {
    stageDraftUpdate(store, dropLastCodePoint(state.draft))
    return true
  }
  if (ch === '\t') {
    const match = extractTrailingAtQuery(state.draft)
    const comp = state.atCompletion
    if (match) {
      if (
        comp
        && comp.atIndex === match.atIndex
        && comp.query === match.query
        && comp.matches.length > 0
      ) {
        const chosen = comp.matches[comp.selectedIndex] ?? comp.matches[0]!
        nextAtQueryGen(store)
        store.setAtCompletion(undefined)
        store.setDraft(`${state.draft.slice(0, match.atIndex)}@${chosen} `)
        return false
      }
      if (deps.completeAtFiles) {
        const draftSnapshot = state.draft
        const gen = nextAtQueryGen(store)
        const applyFirst = (matches: readonly string[]): void => {
          const chosen = matches[0]
          if (
            !chosen
            || atQueryGenByStore.get(store) !== gen
            || store.state.draft !== draftSnapshot
          ) {
            return
          }
          store.setAtCompletion(undefined)
          store.setDraft(`${draftSnapshot.slice(0, match.atIndex)}@${chosen} `)
        }
        const res = deps.completeAtFiles(match.query)
        if (Array.isArray(res)) applyFirst(res)
        else void Promise.resolve(res).then(applyFirst, () => {})
        return false
      }
    }
    deps.toggleThinking()
    return false
  }
  if (ch === '\x1b' || key.escape) {
    if (state.atCompletion !== undefined) {
      nextAtQueryGen(store)
      store.setAtCompletion(undefined)
      return false
    }
    deps.onCancel()
    return false
  }
  if (ch >= ' ' && ch !== '\x7f') {
    stageDraftUpdate(store, state.draft + ch)
    return true
  }
  return false
}
