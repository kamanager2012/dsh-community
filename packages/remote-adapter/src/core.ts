import { RemoteProtocolError } from './errors.js'
import { IdempotencyStore } from './idempotency.js'
import { DeviceRegistry } from './policy.js'
import {
  REMOTE_PROTOCOL_VERSION,
  type ApprovalRespondParams,
  type AuthenticatedPeer,
  type OfficialRemoteSeams,
  type OfficialSessionEvent,
  type PromptSubmitParams,
  type QuestionRespondParams,
  type RemoteRequest,
  type SessionAttachParams,
} from './protocol.js'
import { BoundedReplayBuffer } from './replay.js'

export interface RemoteAdapterOptions {
  readonly replayCapacity?: number
}

export class RemoteAdapterCore {
  readonly devices = new DeviceRegistry()
  private readonly idempotency = new IdempotencyStore()
  private readonly replayBySession = new Map<string, BoundedReplayBuffer>()
  private readonly lastRequestSeq = new Map<string, number>()
  private readonly resolvedInteractions = new Set<string>()
  private readonly replayCapacity: number

  constructor(
    private readonly seams: OfficialRemoteSeams,
    options: RemoteAdapterOptions = {},
  ) {
    this.replayCapacity = options.replayCapacity ?? 500
  }

  onOfficialEvent(sessionId: string, event: OfficialSessionEvent): void {
    let buffer = this.replayBySession.get(sessionId)
    if (!buffer) {
      buffer = new BoundedReplayBuffer(this.replayCapacity)
      this.replayBySession.set(sessionId, buffer)
    }
    buffer.append(event)
  }

  async handle(peer: AuthenticatedPeer, request: RemoteRequest): Promise<unknown> {
    this.assertEnvelope(peer, request)
    this.devices.assertAuthorized(peer.deviceId, request.method)

    switch (request.method) {
      case 'ping':
        return { ok: true }
      case 'session.list':
        return this.seams.listSessions()
      case 'session.attach':
        return this.attach(request.params as SessionAttachParams)
      case 'prompt.submit':
        return this.mutate(
          peer,
          request,
          request.params as PromptSubmitParams,
          async (params) => this.seams.followup(params.sessionId, params.prompt),
        )
      case 'approval.respond':
        return this.mutate(
          peer,
          request,
          request.params as ApprovalRespondParams,
          async (params) => {
            const terminalKey = `approval:${params.callId}`
            if (this.resolvedInteractions.has(terminalKey)) {
              throw new RemoteProtocolError(
                'ALREADY_RESOLVED',
                'approval has already been resolved',
              )
            }
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
          request.params as QuestionRespondParams,
          async (params) => {
            const terminalKey = `question:${params.questionId}`
            if (this.resolvedInteractions.has(terminalKey)) {
              throw new RemoteProtocolError(
                'ALREADY_RESOLVED',
                'question has already been resolved',
              )
            }
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
    if (!Number.isSafeInteger(request.requestSeq) || request.requestSeq < 1) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'invalid request sequence')
    }

    const replayKey = `${peer.deviceId}:${peer.connectionEpoch}`
    const last = this.lastRequestSeq.get(replayKey) ?? 0
    if (request.requestSeq <= last) {
      throw new RemoteProtocolError(
        'REQUEST_REPLAY',
        'request sequence was already observed on this connection',
      )
    }
    this.lastRequestSeq.set(replayKey, request.requestSeq)
  }
}
