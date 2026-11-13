import { RemoteProtocolError } from './errors.js'
import { IdempotencyStore } from './idempotency.js'
import { DeviceRegistry } from './policy.js'
import type { DeviceTrustStore } from './crypto/device-trust.js'
import { InMemoryHostIdentityStore, type HostIdentityStore } from './crypto/host-identity.js'
import {
  REMOTE_PROTOCOL_VERSION,
  parseRemoteRequest,
  type ApprovalRespondParams,
  type AuthenticatedPeer,
  type CreateSessionParams,
  type ModelSelectionParams,
  type OfficialRemoteSeams,
  type OfficialSessionEvent,
  type PromptImageAttachment,
  type PromptImageMediaType,
  type PromptSubmitParams,
  type QuestionRespondParams,
  type RemoteRequest,
  type RenameSessionParams,
  type SessionAttachParams,
  type StreamAckParams,
  type TurnAbortParams,
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
  readonly hostIdentityStore?: HostIdentityStore
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

const ALLOWED_IMAGE_MEDIA_TYPES = new Set<PromptImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])
const MAX_PROMPT_IMAGE_COUNT = 2
const MAX_PROMPT_IMAGE_DECODED_BYTES = 32_768
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u

function parsePromptAttachments(raw: unknown): PromptImageAttachment[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'attachments must be an array')
  }
  if (raw.length === 0) return undefined
  if (raw.length > MAX_PROMPT_IMAGE_COUNT) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      `at most ${MAX_PROMPT_IMAGE_COUNT} image attachments are permitted per prompt`,
    )
  }
  let totalDecodedBytes = 0
  return raw.map((item) => {
    const rec = asObject(item)
    if (rec.type !== 'image') {
      throw new RemoteProtocolError('INVALID_REQUEST', 'attachment type must be image')
    }
    const mediaType = rec.mediaType
    if (typeof mediaType !== 'string' || !ALLOWED_IMAGE_MEDIA_TYPES.has(mediaType as PromptImageMediaType)) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'unsupported image attachment mediaType')
    }
    const rawB64 = requiredString(rec, 'dataBase64').replace(/\s+/gu, '')
    if (rawB64.length % 4 !== 0 || !BASE64_PATTERN.test(rawB64)) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'image attachment dataBase64 is malformed')
    }
    const decoded = Buffer.from(rawB64, 'base64')
    if (decoded.byteLength === 0 || decoded.byteLength > MAX_PROMPT_IMAGE_DECODED_BYTES) {
      throw new RemoteProtocolError(
        'INVALID_REQUEST',
        `image attachment decoded size must be 1..${MAX_PROMPT_IMAGE_DECODED_BYTES} bytes`,
      )
    }
    totalDecodedBytes += decoded.byteLength
    if (totalDecodedBytes > MAX_PROMPT_IMAGE_DECODED_BYTES) {
      throw new RemoteProtocolError(
        'INVALID_REQUEST',
        `combined image attachments exceed ${MAX_PROMPT_IMAGE_DECODED_BYTES} byte transport budget`,
      )
    }
    let name: string | undefined
    if (rec.name !== undefined) {
      if (typeof rec.name !== 'string' || rec.name.trim().length === 0 || rec.name.length > 120) {
        throw new RemoteProtocolError('INVALID_REQUEST', 'attachment name must be 1..120 characters')
      }
      name = rec.name.trim()
    }
    return {
      type: 'image',
      mediaType: mediaType as PromptImageMediaType,
      dataBase64: rawB64,
      ...(name !== undefined ? { name } : {}),
    }
  })
}

function parsePrompt(value: unknown): PromptSubmitParams {
  const object = asObject(value)
  const rawMode = object.mode
  if (rawMode !== undefined && rawMode !== 'followup' && rawMode !== 'steer') {
    throw new RemoteProtocolError('INVALID_REQUEST', 'invalid prompt mode')
  }
  const attachments = parsePromptAttachments(object.attachments)
  const rawPrompt = object.prompt
  if (typeof rawPrompt !== 'string') {
    throw new RemoteProtocolError('INVALID_REQUEST', 'prompt must be a string')
  }
  if (rawPrompt.length === 0 && (!attachments || attachments.length === 0)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'prompt must be a non-empty string')
  }
  return {
    sessionId: requiredString(object, 'sessionId'),
    prompt: rawPrompt,
    ...(rawMode !== undefined ? { mode: rawMode } : {}),
    ...(attachments !== undefined ? { attachments } : {}),
  }
}

function parseRenameSession(value: unknown): RenameSessionParams {
  const object = asObject(value)
  const title = requiredString(object, 'title').trim()
  if (title.length === 0 || title.length > 120) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'title must be a 1..120 character string')
  }
  return {
    sessionId: requiredString(object, 'sessionId'),
    title,
  }
}

function parseCreateSession(value: unknown): CreateSessionParams {
  if (value === undefined) return {}
  const object = asObject(value)
  let sessionId: string | undefined
  if (object.sessionId !== undefined) {
    sessionId = requiredString(object, 'sessionId')
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId)) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'sessionId must match [a-zA-Z0-9_-]{1,128}')
    }
  }
  let title: string | undefined
  if (object.title !== undefined) {
    if (typeof object.title !== 'string' || object.title.trim().length === 0 || object.title.length > 200) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'title must be a 1..200 character string')
    }
    title = object.title.trim()
  }
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(title !== undefined ? { title } : {}),
  }
}

function parseTurnAbort(value: unknown): TurnAbortParams {
  const object = asObject(value)
  if (object.keepInbox !== undefined && typeof object.keepInbox !== 'boolean') {
    throw new RemoteProtocolError('INVALID_REQUEST', 'keepInbox must be a boolean')
  }
  return {
    sessionId: requiredString(object, 'sessionId'),
    ...(object.keepInbox !== undefined ? { keepInbox: object.keepInbox } : {}),
  }
}

function parseModelList(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const object = asObject(value)
  if (object.sessionId === undefined) return undefined
  return requiredString(object, 'sessionId')
}

function parseModelSelect(value: unknown): { readonly sessionId: string; readonly selection: ModelSelectionParams } {
  const object = asObject(value)
  let reasoningEffort: string | undefined
  if (object.reasoningEffort !== undefined) {
    reasoningEffort = requiredString(object, 'reasoningEffort')
  }
  return {
    sessionId: requiredString(object, 'sessionId'),
    selection: {
      provider: requiredString(object, 'provider'),
      model: requiredString(object, 'model'),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    },
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
  readonly hostIdentityStore: HostIdentityStore
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
    this.hostIdentityStore = options.hostIdentityStore ?? new InMemoryHostIdentityStore()
    this.devices = new DeviceRegistry(
      options.trustStore ?? options.maxDevices ?? 128,
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
    // P0-4: Live authoritative check against HostIdentityStore trust domain:
    const hostIdentity = await this.hostIdentityStore.getPublicIdentity()
    this.devices.assertAuthorized(peer.deviceId, request.method, hostIdentity.trustDomainId)

    switch (request.method) {
      case 'ping':
        return { ok: true }
      case 'session.list':
        return this.seams.listSessions()
      case 'session.create':
        return this.mutate(
          peer,
          request,
          parseCreateSession(request.params),
          async (params) => {
            if (!this.seams.createSession) {
              throw new RemoteProtocolError(
                'INVALID_REQUEST',
                'session.create is not supported by this host',
              )
            }
            return this.seams.createSession(params)
          },
        )
      case 'session.rename':
        return this.mutate(
          peer,
          request,
          parseRenameSession(request.params),
          async (params) => {
            if (!this.seams.renameSession) {
              throw new RemoteProtocolError(
                'INVALID_REQUEST',
                'session.rename is not supported by this host',
              )
            }
            return this.seams.renameSession(params.sessionId, params.title)
          },
        )
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
          async (params) => {
            if (params.mode === undefined && params.attachments === undefined) {
              return this.seams.followup(params.sessionId, params.prompt)
            }
            return this.seams.followup(params.sessionId, params.prompt, {
              ...(params.mode !== undefined ? { mode: params.mode } : {}),
              ...(params.attachments !== undefined ? { attachments: params.attachments } : {}),
            })
          },
        )
      case 'turn.abort':
        return this.mutate(
          peer,
          request,
          parseTurnAbort(request.params),
          async (params) => {
            if (!this.seams.abortTurn) {
              throw new RemoteProtocolError(
                'INVALID_REQUEST',
                'turn.abort is not supported by this host',
              )
            }
            return this.seams.abortTurn(
              params.sessionId,
              params.keepInbox !== undefined ? { keepInbox: params.keepInbox } : undefined,
            )
          },
        )
      case 'model.list': {
        const sessionId = parseModelList(request.params)
        if (!this.seams.listModels) {
          return { models: [] }
        }
        return this.seams.listModels(sessionId)
      }
      case 'model.select':
        return this.mutate(
          peer,
          request,
          parseModelSelect(request.params),
          async (params) => {
            if (!this.seams.selectModel) {
              throw new RemoteProtocolError(
                'INVALID_REQUEST',
                'model.select is not supported by this host',
              )
            }
            return this.seams.selectModel(params.sessionId, params.selection)
          },
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
