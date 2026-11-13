import { RemoteProtocolError } from './errors.js'

export const REMOTE_PROTOCOL_VERSION = 1 as const

export type Capability =
  | 'observe'
  | 'prompt'
  | 'approve'
  | 'answer-question'

export type RemoteMethod =
  | 'session.list'
  | 'session.attach'
  | 'session.create'
  | 'prompt.submit'
  | 'turn.abort'
  | 'approval.respond'
  | 'question.respond'
  | 'model.list'
  | 'model.select'
  | 'stream.ack'
  | 'ping'

const REMOTE_METHODS = new Set<RemoteMethod>([
  'session.list',
  'session.attach',
  'session.create',
  'prompt.submit',
  'turn.abort',
  'approval.respond',
  'question.respond',
  'model.list',
  'model.select',
  'stream.ack',
  'ping',
])

export interface RemoteRequest<T = unknown> {
  readonly jsonrpc: '2.0'
  readonly id: string
  readonly method: RemoteMethod
  readonly protocolVersion: number
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
  readonly mode?: PromptSubmitMode | undefined
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

export interface StreamAckParams {
  readonly sessionId: string
  readonly seq: number
}

export type PromptSubmitMode = 'followup' | 'steer'

export interface FollowupOptions {
  readonly mode?: PromptSubmitMode | undefined
}

export interface CreateSessionParams {
  readonly sessionId?: string | undefined
  readonly title?: string | undefined
}

export interface TurnAbortParams {
  readonly sessionId: string
  readonly keepInbox?: boolean | undefined
}

export interface ModelSelectionParams {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
}

export interface ModelOptionRef {
  readonly provider: string
  readonly providerName?: string | undefined
  readonly model: string
  readonly name: string
  readonly description?: string | undefined
}

export interface ModelCatalogResult {
  readonly current?: ModelSelectionParams | undefined
  readonly models: readonly ModelOptionRef[]
}

export interface OfficialRemoteSeams {
  listSessions(): Promise<readonly SessionRef[]>
  assertSession(sessionId: string): Promise<void>
  followup(sessionId: string, prompt: string, options?: FollowupOptions): Promise<unknown>
  respondApproval(callId: string, decision: 'approved' | 'rejected'): Promise<unknown>
  respondQuestion(questionId: string, answer: unknown): Promise<unknown>
  createSession?(options?: CreateSessionParams): Promise<SessionRef>
  abortTurn?(sessionId: string, options?: { readonly keepInbox?: boolean | undefined }): Promise<unknown>
  listModels?(sessionId?: string): Promise<ModelCatalogResult>
  selectModel?(sessionId: string, selection: ModelSelectionParams): Promise<unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRemoteRequest(input: unknown): RemoteRequest {
  if (!isRecord(input)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'request must be an object')
  }

  const {
    jsonrpc,
    id,
    method,
    protocolVersion,
    connectionEpoch,
    requestSeq,
    idempotencyKey,
  } = input

  if (jsonrpc !== '2.0') {
    throw new RemoteProtocolError('INVALID_REQUEST', 'jsonrpc must equal 2.0')
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'request id is required')
  }
  if (typeof method !== 'string' || !REMOTE_METHODS.has(method as RemoteMethod)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'unknown remote method')
  }
  if (!Number.isSafeInteger(protocolVersion)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'protocolVersion must be an integer')
  }
  if (!Number.isSafeInteger(connectionEpoch) || (connectionEpoch as number) < 1) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'connectionEpoch must be positive')
  }
  if (!Number.isSafeInteger(requestSeq) || (requestSeq as number) < 1) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'requestSeq must be positive')
  }
  if (
    idempotencyKey !== undefined
    && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0)
  ) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      'idempotencyKey must be a non-empty string',
    )
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'params')) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'params is required')
  }

  return input as unknown as RemoteRequest
}
