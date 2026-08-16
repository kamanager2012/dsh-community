/**
 * Structural view of the official host seams this surface consumes.
 * Deliberately NOT imports of official packages: the plugin only sees what
 * the runtime hands it, so an upstream rc bump surfaces at runtime/contract,
 * not at our build.
 */

export interface UserMessageLike {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: { readonly kind: 'user' }
}

export interface AgentLike {
  readonly id: string
  readonly options: { readonly model?: string }
  readonly status: string
  readonly ctx: {
    on(event: 'session/event', listener: (event: Record<string, unknown>) => void): void
    on(event: 'agent/status', listener: (payload: { status?: string }) => void): void
  }
  followup(message: UserMessageLike): void
  cancel(cause: string): void
}

export interface AgentHandleLike {
  readonly agent: AgentLike
  dispose(): Promise<void>
}

export interface UserQuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string
  readonly options?: readonly { readonly label: string; readonly description?: string }[]
  readonly multiSelect?: boolean
}

export interface UserQuestionRequest {
  readonly questions: readonly UserQuestionItem[]
  readonly signal?: AbortSignal
}

export interface UserQuestionAnswer {
  readonly answers: readonly {
    readonly id: string
    readonly selected: readonly string[]
    readonly custom?: string
  }[]
}

export interface CordisContext {
  readonly agents: {
    create(input: {
      readonly sessionId: string
      readonly meta?: { readonly cwd?: string }
    }): Promise<AgentHandleLike>
    resume(input: { readonly resumeSessionId: string }): Promise<AgentHandleLike>
  }
  readonly userQuestions: {
    registerProvider(provider: { ask(request: UserQuestionRequest): Promise<UserQuestionAnswer> }): () => void
  }
  on(
    event: 'approval/request',
    listener: (request: unknown, next: () => Promise<string>) => Promise<string>,
  ): void
}
