import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * Structural view of the official host seams this surface consumes.
 * Deliberately narrow: the UI owns presentation only; execution, attachments,
 * sessions, questions, and approvals stay on official DSH services.
 */

export type ImageMediaTypeLike = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export type ImageAttachmentRefLike =
  Extract<ContentBlock, { readonly type: 'image' }>['attachment']

export interface SaveImageAttachmentLike {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaTypeLike
  readonly name?: string
}

export interface AttachmentStoreLike {
  readonly imageLimits: {
    readonly maxImageBytes: number
    readonly maxImagesPerMessage: number
    readonly maxMessageImageBytes: number
    readonly maxImagePixels: number
    readonly maxImageDimension: number
    readonly mediaTypes: readonly ImageMediaTypeLike[]
  }
  saveImages(
    inputs: readonly SaveImageAttachmentLike[],
  ): Promise<readonly ImageAttachmentRefLike[]>
}

export interface UserMessageLike {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly ContentBlock[]
  readonly source: { readonly kind: 'user' }
}

export interface AgentLike {
  readonly id: string
  readonly options: { readonly model?: string }
  readonly status: string
  whenIdle(): Promise<void>
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

export interface ModelSelectionLike {
  readonly provider: string
  readonly model: string
}

export interface CordisContext {
  get(name: 'loader'): { await(): Promise<void> } | undefined
  get(name: string): unknown
  readonly attachments: AttachmentStoreLike
  readonly agentDefaultModel: {
    currentSelection(): ModelSelectionLike
  }
  readonly agents: {
    create(input: {
      readonly sessionId: string
      readonly meta?: { readonly cwd?: string }
      readonly agentOptions?: { readonly provider: string; readonly model: string }
      readonly setup?: (agentCtx: unknown) => void
    }): Promise<AgentHandleLike>
    resume(input: {
      readonly resumeSessionId: string
      readonly agentOptions?: { readonly provider: string; readonly model: string }
      readonly setup?: (agentCtx: unknown) => void
    }): Promise<AgentHandleLike>
  }
  readonly userQuestions: {
    registerProvider(provider: { ask(request: UserQuestionRequest): Promise<UserQuestionAnswer> }): () => void
  }
  on(
    event: 'approval/request',
    listener: (request: unknown, next: () => Promise<string>) => Promise<string>,
  ): void
}
