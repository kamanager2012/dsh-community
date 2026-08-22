import type { UiStore } from './store.js'

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
}

export interface KeyHandlerDeps {
  readonly store: UiStore
  readonly onSend: (text: string) => void
  readonly onCancel: () => void
  readonly onExit: () => void
  readonly showHelp: () => void
  readonly toggleThinking: () => void
}

/** Handle one useInput callback (one keypress, possibly several characters). */
export function handleKey(deps: KeyHandlerDeps, raw: string, key: KeyEvent = {}): void {
  const list = key.return ? ['\r'] : [...raw].map((ch) => ch === '\n' ? '\r' : ch)
  for (const ch of list) {
    applyChar(deps, ch, key)
  }
}

function applyChar(deps: KeyHandlerDeps, ch: string, key: KeyEvent): void {
  const { store } = deps
  const state = store.state

  if (state.approval !== undefined) {
    if (ch === 'y') store.resolveApproval('allowed-once')
    else if (ch === 'n') store.resolveApproval('rejected')
    return
  }

  if (state.questions !== undefined) {
    const question = state.questions.request.questions[0]
    if (question === undefined) return
    const options = question.options ?? []
    if (options.length > 0) {
      const index = Number(ch) - 1
      if (Number.isInteger(index) && index >= 0 && index < options.length) {
        store.resolveQuestions({ answers: [{ id: question.id, selected: [options[index]!.label] }] })
      }
      return
    }
    if (ch === '\r') {
      const answer = state.draft.trim()
      store.setDraft('')
      store.resolveQuestions({
        answers: [{ id: question.id, selected: [], ...(answer === '' ? {} : { custom: answer }) }],
      })
      return
    }
    if (ch >= ' ' && ch !== '\x7f') store.setDraft(state.draft + ch)
    return
  }

  if (ch === '\r') {
    const trimmed = state.draft.trim()
    store.setDraft('')
    if (trimmed === '/exit') process.exit(0)
    else if (trimmed === '/help') deps.showHelp()
    else if (trimmed !== '') deps.onSend(trimmed)
    return
  }
  if (ch === '\t') {
    deps.toggleThinking()
    return
  }
  if (ch === '\x1b' || key.escape) {
    deps.onCancel()
    return
  }
  if (ch === 'q' && key.ctrl) deps.onExit()
  if (ch >= ' ' && ch !== '\x7f') store.setDraft(state.draft + ch)
}
