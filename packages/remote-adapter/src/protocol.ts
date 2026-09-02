export const REMOTE_PROTOCOL_VERSION = 1 as const

export type Capability =
  | 'observe'
  | 'prompt'
  | 'approve'
  | 'answer-question'

export type RemoteMethod =
  | 'session.list'
  | 'session.attach'
  | 'prompt.submit'
  | 'approval.respond'
  | 'question.respond'
  | 'ping'

export interface RemoteRequest<T = unknown> {
  readonly jsonrpc: '2.0'
  readonly id: string
  readonly method: RemoteMethod
  readonly protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  readonly connectionEpoch: number
  readonly requestSeq: number
  readonly idempotencyKey?: string
  readonly params: T
}

export interface AuthenticatedPeer {
  readonly deviceId: string
  readonly connectionEpoch: number
}

export interface SessionRef {
  readonly id: string
  readonly title?: string
}

export interface OfficialSessionEvent {
  readonly seq: number
  readonly type: string
  readonly data?: unknown
}

export interface PromptSubmitParams {
  readonly sessionId: string
  readonly prompt: string
}

export interface ApprovalRespondParams {
  readonly callId: string
  readonly decision: 'approved' | 'rejected'
}

export interface QuestionRespondParams {
  readonly questionId: string
  readonly answer: unknown
}

export interface SessionAttachParams {
  readonly sessionId: string
  readonly afterSeq?: number
}

export interface OfficialRemoteSeams {
  listSessions(): Promise<readonly SessionRef[]>
  assertSession(sessionId: string): Promise<void>
  followup(sessionId: string, prompt: string): Promise<unknown>
  respondApproval(callId: string, decision: 'approved' | 'rejected'): Promise<unknown>
  respondQuestion(questionId: string, answer: unknown): Promise<unknown>
}
