import { RemoteProtocolError } from './errors.js'
import { IdempotencyStore } from './idempotency.js'
import { DeviceRegistry } from './policy.js'
import {
  REMOTE_PROTOCOL_VERSION,
  parseRemoteRequest,
  type ApprovalRespondParams,
  type AuthenticatedPeer,
  type OfficialRemoteSeams,
  type OfficialSessionEvent,
  type PromptSubmitParams,
  type QuestionRespondParams,
  type RemoteRequest,
  type SessionAttachParams,
  type StreamAckParams,
} from './protocol.js'
import { BoundedReplayBuffer } from './replay.js'

export interface RemoteAdapterOptions {
  readonly replayCapacity?: number
  readonly idempotencyCapacity?: number
  readonly terminalStateCapacity?: number
  readonly connectionStateCapacity?: number
  readonly maxDevices?: number
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'params must be an object')
  }
  return value as Record<string, unknown>
}

function requiredString(
  object: Record<string, unknown>,
  key: string,
): string {
  const value = object[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RemoteProtocolError('INVALID_REQUEST', `${key} must be a non-empty string`)
  }
  return value
}

function parsePrompt(value: unknown): PromptSubmitParams {
  const object = asObject(value)
  return {
    sessionId: requiredString(object, 'sessionId'),
    prompt: requiredString(object, 'prompt'),
  }
}

function parseApproval(value: unknown): ApprovalRespondParams {
  const object = asObject(value)
  const decision = object.decision
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new RemoteProtocolError('INVALID_REQUEST', 'invalid approval decision')
  }
  return {
    callId: requiredString(object, 'callId'),
    decision,
  }
}

function parseQuestion(value: unknown): QuestionRespondParams {
  const object = asObject(value)
  if (!Object.prototype.hasOwnProperty.call(object, 'answer')) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'answer is required')
  }
  return {
    questionId: requiredString(object, 'questionId'),
    answer: object.answer,
  }
}

function parseAttach(value: unknown): SessionAttachParams {
  const object = asObject(value)
  const afterSeq = object.afterSeq
  if (
    afterSeq !== undefined
    && (!Number.isSafeInteger(afterSeq) || (afterSeq as number) < 0)
  ) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'afterSeq must be a non-negative integer')
  }
  return {
    sessionId: requiredString(object, 'sessionId'),
    afterSeq: afterSeq as number | undefined,
  }
}

function parseAck(value: unknown): StreamAckParams {
  const object = asObject(value)
  const seq = object.seq
  if (!Number.isSafeInteger(seq) || (seq as number) < 0) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'seq must be a non-negative integer')
  }
  return {
    sessionId: requiredString(object, 'sessionId'),
    seq: seq as number,
  }
}

export class RemoteAdapterCore {
  readonly devices: DeviceRegistry
  private readonly idempotency: IdempotencyStore
  private readonly replayBySession = new Map<string, BoundedReplayBuffer>()
  private readonly lastRequestSeq = new Map<string, number>()
  private readonly resolvedInteractions = new Set<string>()
  private readonly lastAck = new Map<string, number>()
  private readonly replayCapacity: number
  private readonly terminalStateCapacity: number
  private readonly connectionStateCapacity: number

  constructor(
    private readonly seams: OfficialRemoteSeams,
    options: RemoteAdapterOptions = {},
  ) {
    this.replayCapacity = options.replayCapacity ?? 500
    this.terminalStateCapacity = options.terminalStateCapacity ?? 4096
    this.connectionStateCapacity = options.connectionStateCapacity ?? 1024
    this.devices = new DeviceRegistry(options.maxDevices ?? 128)
    this.idempotency = new IdempotencyStore(options.idempotencyCapacity ?? 4096)
  }

  onOfficialEvent(sessionId: string, event: OfficialSessionEvent): void {
    let buffer = this.replayBySession.get(sessionId)
    if (!buffer) {
      buffer = new BoundedReplayBuffer(this.replayCapacity)
      this.replayBySession.set(sessionId, buffer)
    }
    buffer.append(event)
  }

  closeConnection(peer: AuthenticatedPeer): void {
    this.lastRequestSeq.delete(`${peer.deviceId}:${peer.connectionEpoch}`)
  }

  async handle(peer: AuthenticatedPeer, input: unknown): Promise<unknown> {
    const request = parseRemoteRequest(input)
    this.assertEnvelope(peer, request)
    this.devices.assertAuthorized(peer.deviceId, request.method)

    switch (request.method) {
      case 'ping':
        return { ok: true }
      case 'session.list':
        return this.seams.listSessions()
      case 'session.attach':
        return this.attach(parseAttach(request.params))
      case 'stream.ack': {
        const params = parseAck(request.params)
        this.lastAck.set(`${peer.deviceId}:${params.sessionId}`, params.seq)
        return { ok: true }
      }
      case 'prompt.submit':
        return this.mutate(
          peer,
          request,
          parsePrompt(request.params),
          async (params) => this.seams.followup(params.sessionId, params.prompt),
        )
      case 'approval.respond':
        return this.mutate(
          peer,
          request,
          parseApproval(request.params),
          async (params) => {
            const terminalKey = `approval:${params.callId}`
            this.assertInteractionOpen(terminalKey)
            const value = await this.seams.respondApproval(
              params.callId,
              params.decision,
            )
            this.resolvedInteractions.add(terminalKey)
            return value
          },
        )
      case 'question.respond':
        return this.mutate(
          peer,
          request,
          parseQuestion(request.params),
          async (params) => {
            const terminalKey = `question:${params.questionId}`
            this.assertInteractionOpen(terminalKey)
            const value = await this.seams.respondQuestion(
              params.questionId,
              params.answer,
            )
            this.resolvedInteractions.add(terminalKey)
            return value
          },
        )
    }
  }

  private assertInteractionOpen(terminalKey: string): void {
    if (this.resolvedInteractions.has(terminalKey)) {
      throw new RemoteProtocolError(
        'ALREADY_RESOLVED',
        'interaction has already been resolved',
      )
    }
    if (this.resolvedInteractions.size >= this.terminalStateCapacity) {
      throw new RemoteProtocolError(
        'STATE_CAPACITY_EXCEEDED',
        'terminal interaction capacity is exhausted',
      )
    }
  }

  private async attach(params: SessionAttachParams): Promise<unknown> {
    await this.seams.assertSession(params.sessionId)
    const buffer = this.replayBySession.get(params.sessionId)
    return buffer?.resume(params.afterSeq) ?? { kind: 'events', events: [] }
  }

  private async mutate<TParams, TResult>(
    peer: AuthenticatedPeer,
    request: RemoteRequest,
    params: TParams,
    operation: (params: TParams) => Promise<TResult>,
  ): Promise<TResult> {
    if (!request.idempotencyKey) {
      throw new RemoteProtocolError(
        'IDEMPOTENCY_REQUIRED',
        'mutating requests require an idempotency key',
      )
    }
    return this.idempotency.run(
      `${peer.deviceId}:${request.method}`,
      request.idempotencyKey,
      params,
      () => operation(params),
    )
  }

  private assertEnvelope(peer: AuthenticatedPeer, request: RemoteRequest): void {
    if (request.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
      throw new RemoteProtocolError(
        'PROTOCOL_VERSION_UNSUPPORTED',
        'unsupported remote protocol version',
      )
    }
    if (request.connectionEpoch < peer.connectionEpoch) {
      throw new RemoteProtocolError('EPOCH_STALE', 'connection epoch is stale')
    }
    if (request.connectionEpoch !== peer.connectionEpoch) {
      throw new RemoteProtocolError(
        'EPOCH_MISMATCH',
        'request is not bound to the authenticated connection epoch',
      )
    }

    const replayKey = `${peer.deviceId}:${peer.connectionEpoch}`
    const last = this.lastRequestSeq.get(replayKey)
    if (last === undefined && this.lastRequestSeq.size >= this.connectionStateCapacity) {
      throw new RemoteProtocolError(
        'STATE_CAPACITY_EXCEEDED',
        'connection replay-state capacity is exhausted',
      )
    }
    if (request.requestSeq <= (last ?? 0)) {
      throw new RemoteProtocolError(
        'REQUEST_REPLAY',
        'request sequence was already observed on this connection',
      )
    }
    this.lastRequestSeq.set(replayKey, request.requestSeq)
  }
}
