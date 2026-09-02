/**
 * dsh-community-tui: the community-owned terminal surface.
 *
 * Own code only. All execution stays on official host seams:
 *   ctx.agents.create/resume + agent.followup  → official Agent
 *   ctx.attachments.saveImages                 → official durable image refs
 *   session/event                              → official durable log
 *   ctx.userQuestions.registerProvider         → official ask_user_question
 *   approval/request waterfall                 → official sandbox approval
 *
 * Official types are consumed structurally — no third-party harness products
 * are imported, mounted, or patched.
 */

import { formatDualBadge } from './badge.js'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { render } from 'ink'
import { createElement } from 'react'
import { randomUUID } from 'node:crypto'
import { App } from './ui.js'
import { buildUserContent } from './image-input.js'
import { createStore, type UiStore } from './store.js'
import type { AgentHandleLike, CordisContext, UserQuestionRequest } from './types.js'
// eslint-disable-next-line @typescript-eslint/no-explicit-any

/** Resume contract shared with the community launcher. */
const RESUME_ENV = ['DSH_TUI_RESUME_SESSION', 'DSH_CC_RESUME_SESSION'] as const

export const name = 'dsh-community-tui'

export const inject = ['agents', 'userQuestions', 'agentDefaultModel', 'attachments'] as const

interface ApprovalRequestLike {
  readonly agent?: { readonly id?: string }
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: CordisContext): (() => void) | void {
  if (!process.stdout.isTTY) return

  const store = createStore()

  // Capture the launcher-provided first turn once, then scrub it before any
  // agent/tool subprocess can inherit the environment. This keeps task text
  // out of argv and minimizes its process-environment lifetime.
  const firstPromptRaw = process.env.DSH_TUI_FIRST_PROMPT
  delete process.env.DSH_TUI_FIRST_PROMPT
  const firstPrompt = firstPromptRaw?.trim()

  const resumeEnv = (process.env[RESUME_ENV[0]] ?? process.env[RESUME_ENV[1]])?.trim()
  const resumeId = resumeEnv === undefined || resumeEnv === '' ? undefined : resumeEnv

  let current: AgentHandleLike | undefined
  let unmount: (() => void) | undefined

  ctx.userQuestions.registerProvider({
    ask(request: UserQuestionRequest) {
      return store.askQuestions(request)
    },
  })

  ctx.on('approval/request', async (request: unknown, next: () => Promise<string>) => {
    const approval = request as ApprovalRequestLike
    if (current === undefined || approval.agent?.id !== current.agent.id) return next()
    if (approval.signal?.aborted) return 'cancelled'
    return store.askApproval({ toolName: approval.toolName, ...(approval.callId === undefined ? {} : { callId: approval.callId }), ...(approval.reason === undefined ? {} : { reason: approval.reason }) })
  })

  const run = async (): Promise<void> => {
    const loader = ctx.get('loader')
    if (loader !== undefined && typeof (loader as { await?: unknown }).await === 'function') {
      await (loader as { await(): Promise<void> }).await()
    }
    const defaultModel = ctx.agentDefaultModel
    const selection = defaultModel.currentSelection()

    let handle: AgentHandleLike
    if (resumeId !== undefined) {
      handle = await ctx.agents.resume({
        resumeSessionId: resumeId,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx: unknown) => {
          installModelSelection(agentCtx as never, { current: selection, assembled: undefined })
        },
      })
    } else {
      handle = await ctx.agents.create({
        sessionId: SessionId(`session-${randomUUID()}`),
        meta: { cwd: process.cwd() },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx: unknown) => {
          installModelSelection(agentCtx as never, { current: selection, assembled: undefined })
        },
      })
    }
    await handle.agent.whenIdle()
    current = handle

    const agent = handle.agent
    store.setModel(agent.options.model ?? 'default')
    store.setStatus(agent.status)

    agent.ctx.on('session/event', (event: Record<string, unknown>) => {
      store.applySessionEvent(event)
    })

    let sendChain = Promise.resolve()
    const enqueueUserInput = (text: string): void => {
      sendChain = sendChain.then(async () => {
        try {
          const { content } = await buildUserContent(text, ctx.attachments)
          agent.followup(createUserMessage({
            content,
            source: { kind: 'user' },
          }))
        } catch (error) {
          store.showHelp(`发送失败：${errorMessage(error)}`)
        }
      })
    }

    if (firstPrompt !== undefined && firstPrompt !== '') {
      enqueueUserInput(firstPrompt)
    }
    agent.ctx.on('agent/status', (payload: { status?: string }) => {
      store.setStatus(payload.status ?? 'idle')
    })

    const ui = render(createElement(App, {
      store,
      dualBadge: formatDualBadge(),
      onSend: enqueueUserInput,
      onCancel: () => agent.cancel('user-interrupt'),
      onExit: () => {
        void handle.dispose()
        process.exit(0)
      },
    }))
    unmount = () => ui.unmount()
  }

  void run().catch((error: unknown) => {
    store.setFatal(errorMessage(error))
  })

  return () => {
    unmount?.()
    if (current !== undefined) void current.dispose()
  }
}

export { createStore, type UiStore } from './store.js'
export type { AgentHandleLike, CordisContext } from './types.js'
