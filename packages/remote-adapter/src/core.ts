import { RemoteProtocolError } from './errors.js'
import { IdempotencyStore } from './idempotency.js'
import { DeviceRegistry } from './policy.js'
import type { DeviceTrustStore } from './crypto/device-trust.js'
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
  readonly replayByteCapacity?: number
  readonly maxReplaySessions?: number
  readonly idempotencyCapacity?: number
  readonly terminalStateCapacity?: number
  readonly connectionStateCapacity?: number
  readonly maxDevices?: number
  readonly trustStore?: DeviceTrustStore
  readonly currentTrustDomainId?: string
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
  const sessionId = requiredString(object, 'sessionId')
  if (afterSeq === undefined) return { sessionId }
  return { sessionId, afterSeq: afterSeq as number }
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
  readonly trustStore: DeviceTrustStore
  private readonly idempotency: IdempotencyStore
  private readonly replayBySession = new Map<string, BoundedReplayBuffer>()
  private readonly lastRequestSeq = new Map<string, number>()
  private readonly claimedInteractions = new Set<string>()
  private readonly replayCapacity: number
  private readonly replayByteCapacity: number
  private readonly maxReplaySessions: number
  private readonly terminalStateCapacity: number
  private readonly connectionStateCapacity: number

  constructor(
    private readonly seams: OfficialRemoteSeams,
    options: RemoteAdapterOptions = {},
  ) {
    this.replayCapacity = options.replayCapacity ?? 500
    this.replayByteCapacity = options.replayByteCapacity ?? 2 * 1024 * 1024
    this.maxReplaySessions = options.maxReplaySessions ?? 64
    if (!Number.isInteger(this.maxReplaySessions) || this.maxReplaySessions < 1) {
      throw new Error('maxReplaySessions must be a positive integer')
    }
    this.terminalStateCapacity = options.terminalStateCapacity ?? 4096
    this.connectionStateCapacity = options.connectionStateCapacity ?? 1024
    this.devices = new DeviceRegistry(
      options.trustStore ?? options.maxDevices ?? 128,
      options.currentTrustDomainId ?? 'default-trust-domain',
    )
    this.trustStore = this.devices.trustStore
    this.idempotency = new IdempotencyStore(options.idempotencyCapacity ?? 4096)
  }

  onOfficialEvent(sessionId: string, event: OfficialSessionEvent): void {
    let buffer = this.replayBySession.get(sessionId)
    if (!buffer) {
      if (this.replayBySession.size >= this.maxReplaySessions) {
        const oldestSessionId = this.replayBySession.keys().next().value
        if (typeof oldestSessionId === 'string') {
          this.replayBySession.delete(oldestSessionId)
        }
      }
      buffer = new BoundedReplayBuffer(
        this.replayCapacity,
        this.replayByteCapacity,
      )
    } else {
      // Refresh insertion order so eviction is least-recently-used by event.
      this.replayBySession.delete(sessionId)
    }
    this.replayBySession.set(sessionId, buffer)
    buffer.append(event)
  }

  forgetSession(sessionId: string): void {
    this.replayBySession.delete(sessionId)
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
        await this.seams.assertSession(params.sessionId)
        // R1 validates the ACK contract but intentionally retains no ACK map.
        // Resume truth is the official Session sequence supplied on attach.
        return { ok: true, seq: params.seq }
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
            this.claimInteraction(terminalKey)
            return this.seams.respondApproval(
              params.callId,
              params.decision,
            )
          },
        )
      case 'question.respond':
        return this.mutate(
          peer,
          request,
          parseQuestion(request.params),
          async (params) => {
            const terminalKey = `question:${params.questionId}`
            this.claimInteraction(terminalKey)
            return this.seams.respondQuestion(
              params.questionId,
              params.answer,
            )
          },
        )
    }
  }

  private claimInteraction(terminalKey: string): void {
    if (this.claimedInteractions.has(terminalKey)) {
      throw new RemoteProtocolError(
        'ALREADY_RESOLVED',
        'interaction has already been claimed or resolved',
      )
    }
    if (this.claimedInteractions.size >= this.terminalStateCapacity) {
      throw new RemoteProtocolError(
        'STATE_CAPACITY_EXCEEDED',
        'terminal interaction capacity is exhausted',
      )
    }

    // Reserve before touching the official seam. If the seam later rejects,
    // the claim remains fail-closed because the side-effect state may be
    // uncertain; callers must reconcile from official Session truth.
    this.claimedInteractions.add(terminalKey)
  }

  private async attach(params: SessionAttachParams): Promise<unknown> {
    await this.seams.assertSession(params.sessionId)
    const buffer = this.replayBySession.get(params.sessionId)
    if (!buffer) {
      if (params.afterSeq !== undefined) {
        return { kind: 'reset', reason: 'window-unavailable' }
      }
      return { kind: 'events', events: [] }
    }

    // Refresh insertion order on attach as well as on event receipt.
    this.replayBySession.delete(params.sessionId)
    this.replayBySession.set(params.sessionId, buffer)
    return buffer.resume(params.afterSeq)
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
