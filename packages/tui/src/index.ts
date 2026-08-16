/**
 * dsh-community-tui: the community-owned terminal surface.
 *
 * Own code only. All execution stays on official host seams:
 *   ctx.agents.create/resume + agent.followup  → official Agent
 *   session/event                               → official durable log
 *   ctx.userQuestions.registerProvider          → official ask_user_question
 *   approval/request waterfall                  → official sandbox approval
 *
 * Official types are consumed structurally — no third-party harness products
 * are imported, mounted, or patched.
 */

import { render, type Instance } from 'ink'
import { createElement } from 'react'
import { randomUUID } from 'node:crypto'
import { App } from './ui.js'
import { createStore, type UiStore } from './store.js'
import type { AgentHandleLike, CordisContext, UserQuestionRequest } from './types.js'
// eslint-disable-next-line @typescript-eslint/no-explicit-any

/** Resume contract shared with the community launcher. */
const RESUME_ENV = ['DSH_TUI_RESUME_SESSION', 'DSH_CC_RESUME_SESSION'] as const

export const name = 'dsh-community-tui'

export const inject = ['agents', 'userQuestions'] as const

interface ApprovalRequestLike {
  readonly agent?: { readonly id?: string }
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

export function apply(ctx: CordisContext): (() => void) | void {
  if (!process.stdout.isTTY) return

  const store = createStore()

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
    let handle: AgentHandleLike
    if (resumeId !== undefined) {
      handle = await ctx.agents.resume({ resumeSessionId: resumeId })
    } else {
      handle = await ctx.agents.create({
        sessionId: randomUUID(),
        meta: { cwd: process.cwd() },
      })
    }
    current = handle

    const agent = handle.agent
    store.setModel(agent.options.model ?? 'default')
    store.setStatus(agent.status)

    agent.ctx.on('session/event', (event: Record<string, unknown>) => {
      store.applySessionEvent(event)
    })
    agent.ctx.on('agent/status', (payload: { status?: string }) => {
      store.setStatus(payload.status ?? 'idle')
    })

    const ui = render(createElement(App, {
      store,
      onSend: (text: string) => {
        agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
      },
      onCancel: () => agent.cancel('user-interrupt'),
      onExit: () => {
        void handle.dispose()
        process.exit(0)
      },
    }))
    unmount = () => ui.unmount()
  }

  void run().catch((error: unknown) => {
    store.setFatal(error instanceof Error ? error.message : String(error))
  })

  return () => {
    unmount?.()
    if (current !== undefined) void current.dispose()
  }
}

export { createStore, type UiStore } from './store.js'
export type { AgentHandleLike, CordisContext } from './types.js'
