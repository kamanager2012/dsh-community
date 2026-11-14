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
  type SessionForkParams,
  type SessionHistoryParams,
  type SessionSearchParams,
  type StreamAckParams,
  type TurnAbortParams,
  type WorkspaceUploadAbortParams,
  type WorkspaceUploadChunkParams,
  type WorkspaceUploadCommitParams,
  type WorkspaceUploadOpenParams,
} from './protocol.js'
import { BoundedReplayBuffer } from './replay.js'
import { isSafeSessionId } from './session-transcript.js'

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

function requiredSafeSessionId(
  object: Record<string, unknown>,
  key: string,
): string {
  const value = requiredString(object, key)
  if (!isSafeSessionId(value)) {
    throw new RemoteProtocolError('INVALID_REQUEST', `${key} contains invalid path segments or characters`)
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
    sessionId: requiredSafeSessionId(object, 'sessionId'),
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
    sessionId: requiredSafeSessionId(object, 'sessionId'),
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
    sessionId: requiredSafeSessionId(object, 'sessionId'),
    ...(object.keepInbox !== undefined ? { keepInbox: object.keepInbox } : {}),
  }
}

function parseModelList(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const object = asObject(value)
  if (object.sessionId === undefined) return undefined
  return requiredSafeSessionId(object, 'sessionId')
}

function parseModelSelect(value: unknown): { readonly sessionId: string; readonly selection: ModelSelectionParams } {
  const object = asObject(value)
  let reasoningEffort: string | undefined
  if (object.reasoningEffort !== undefined) {
    reasoningEffort = requiredString(object, 'reasoningEffort')
  }
  return {
    sessionId: requiredSafeSessionId(object, 'sessionId'),
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
  const sessionId = requiredSafeSessionId(object, 'sessionId')
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
    sessionId: requiredSafeSessionId(object, 'sessionId'),
    seq: seq as number,
  }
}

function parseSessionHistory(value: unknown): SessionHistoryParams {
  const object = asObject(value)
  const sessionId = requiredSafeSessionId(object, 'sessionId')
  let beforeSeq: number | undefined
  if (object.beforeSeq !== undefined) {
    if (!Number.isSafeInteger(object.beforeSeq) || (object.beforeSeq as number) < 1) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'beforeSeq must be a positive integer')
    }
    beforeSeq = object.beforeSeq as number
  }
  let limit: number | undefined
  if (object.limit !== undefined) {
    if (!Number.isSafeInteger(object.limit) || (object.limit as number) < 1 || (object.limit as number) > 200) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'limit must be an integer between 1 and 200')
    }
    limit = object.limit as number
  }
  let minTurns: number | undefined
  if (object.minTurns !== undefined) {
    if (!Number.isSafeInteger(object.minTurns) || (object.minTurns as number) < 0 || (object.minTurns as number) > 20) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'minTurns must be an integer between 0 and 20')
    }
    minTurns = object.minTurns as number
  }
  return {
    sessionId,
    ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(minTurns !== undefined ? { minTurns } : {}),
  }
}

function parseSessionFork(value: unknown): SessionForkParams {
  const object = asObject(value)
  const sessionId = requiredSafeSessionId(object, 'sessionId')
  let atSeq: number | undefined
  if (object.atSeq !== undefined) {
    if (!Number.isSafeInteger(object.atSeq) || (object.atSeq as number) < 0) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'atSeq must be a non-negative integer')
    }
    atSeq = object.atSeq as number
  }
  let title: string | undefined
  if (object.title !== undefined) {
    const trimmed = requiredString(object, 'title').trim()
    if (trimmed.length === 0 || trimmed.length > 200) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'title must be a 1..200 character string')
    }
    title = trimmed
  }
  return {
    sessionId,
    ...(atSeq !== undefined ? { atSeq } : {}),
    ...(title !== undefined ? { title } : {}),
  }
}

function parseSessionSearch(value: unknown): SessionSearchParams {
  const object = asObject(value)
  const query = requiredString(object, 'query').trim()
  if (query.length === 0 || query.length > 256) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'query must be a 1..256 character string')
  }
  let sessionId: string | undefined
  if (object.sessionId !== undefined) {
    sessionId = requiredSafeSessionId(object, 'sessionId')
  }
  let limit: number | undefined
  if (object.limit !== undefined) {
    if (!Number.isSafeInteger(object.limit) || (object.limit as number) < 1 || (object.limit as number) > 50) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'limit must be an integer between 1 and 50')
    }
    limit = object.limit as number
  }
  return {
    query,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }
}

function parseCommandExecute(value: unknown): { readonly sessionId: string; readonly command: string } {
  const object = asObject(value)
  const sessionId = requiredSafeSessionId(object, 'sessionId')
  const command = requiredString(object, 'command').trim()
  if (command.length === 0 || command.length > 2048 || /[\u0000-\u0008\u000b-\u001f]/u.test(command)) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'command must be a valid 1..2048 character command line')
  }
  return { sessionId, command }
}

function parseWorkspaceUploadOpen(value: unknown): WorkspaceUploadOpenParams {
  const object = asObject(value)
  const sessionId = requiredSafeSessionId(object, 'sessionId')
  const filename = requiredString(object, 'filename')
  const sizeBytes = object.sizeBytes
  if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 1) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'sizeBytes must be a positive safe integer')
  }
  let chunkBytes: number | undefined
  if (object.chunkBytes !== undefined) {
    if (!Number.isSafeInteger(object.chunkBytes) || (object.chunkBytes as number) < 1) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'chunkBytes must be a positive safe integer')
    }
    chunkBytes = object.chunkBytes as number
  }
  let sha256: string | undefined
  if (object.sha256 !== undefined) {
    sha256 = requiredString(object, 'sha256')
  }
  let conflictPolicy: 'rename' | 'fail' | undefined
  if (object.conflictPolicy !== undefined) {
    if (object.conflictPolicy !== 'rename' && object.conflictPolicy !== 'fail') {
      throw new RemoteProtocolError('INVALID_REQUEST', 'conflictPolicy must be rename or fail')
    }
    conflictPolicy = object.conflictPolicy
  }
  return {
    sessionId,
    filename,
    sizeBytes: sizeBytes as number,
    ...(chunkBytes !== undefined ? { chunkBytes } : {}),
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(conflictPolicy !== undefined ? { conflictPolicy } : {}),
  }
}

function parseWorkspaceUploadChunk(value: unknown): WorkspaceUploadChunkParams {
  const object = asObject(value)
  const uploadId = requiredString(object, 'uploadId')
  const offset = object.offset
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
    throw new RemoteProtocolError('INVALID_REQUEST', 'offset must be a non-negative integer')
  }
  const dataBase64 = requiredString(object, 'dataBase64')
  return {
    uploadId,
    offset: offset as number,
    dataBase64,
  }
}

function parseWorkspaceUploadCommit(value: unknown): WorkspaceUploadCommitParams {
  const object = asObject(value)
  const uploadId = requiredString(object, 'uploadId')
  let sha256: string | undefined
  if (object.sha256 !== undefined) {
    sha256 = requiredString(object, 'sha256')
  }
  return {
    uploadId,
    ...(sha256 !== undefined ? { sha256 } : {}),
  }
}

function parseWorkspaceUploadAbort(value: unknown): WorkspaceUploadAbortParams {
  const object = asObject(value)
  return {
    uploadId: requiredString(object, 'uploadId'),
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

  getReplayWindowInfo(
    sessionId: string,
  ): { readonly oldestSeq: number | null; readonly latestSeq: number | null; readonly size: number } | undefined {
    const buffer = this.replayBySession.get(sessionId)
    if (!buffer) return undefined
    return {
      oldestSeq: buffer.getOldestSeq() ?? null,
      latestSeq: buffer.getLatestSeq() ?? null,
      size: buffer.size(),
    }
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
      case 'session.history': {
        const params = parseSessionHistory(request.params)
        await this.seams.assertSession(params.sessionId)
        if (!this.seams.getSessionHistory) {
          throw new RemoteProtocolError(
            'INVALID_REQUEST',
            'session.history is not supported by this host',
          )
        }
        return this.seams.getSessionHistory(params)
      }
      case 'session.search': {
        const params = parseSessionSearch(request.params)
        if (params.sessionId !== undefined) {
          await this.seams.assertSession(params.sessionId)
        }
        if (!this.seams.searchSessions) {
          throw new RemoteProtocolError(
            'INVALID_REQUEST',
            'session.search is not supported by this host',
          )
        }
        return this.seams.searchSessions(params)
      }
      case 'session.fork':
        return this.mutate(
          peer,
          request,
          parseSessionFork(request.params),
          async (params) => {
            await this.seams.assertSession(params.sessionId)
            if (!this.seams.forkSession) {
              throw new RemoteProtocolError(
                'INVALID_REQUEST',
                'session.fork is not supported by this host',
              )
            }
            return this.seams.forkSession(params)
          },
        )
      case 'command.list': {
        const sessionId = parseModelList(request.params)
        if (sessionId !== undefined) {
          await this.seams.assertSession(sessionId)
        }
        const commands = this.seams.listCommands ? await this.seams.listCommands(sessionId) : []
        return { commands }
      }
      case 'command.execute':
        return this.mutate(
          peer,
          request,
          parseCommandExecute(request.params),
          async (params) => {
            await this.seams.assertSession(params.sessionId)
            if (!this.seams.executeCommand) {
              throw new RemoteProtocolError(
                'INVALID_REQUEST',
                'command.execute is not supported by this host',
              )
            }
            return this.seams.executeCommand(params.sessionId, params.command)
          },
        )
      case 'skill.list': {
        const sessionId = parseModelList(request.params)
        if (sessionId !== undefined) {
          await this.seams.assertSession(sessionId)
        }
        const skills = this.seams.listSkills ? await this.seams.listSkills(sessionId) : []
        return { skills }
      }
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
      case 'workspace.upload.open':
        return this.mutate(
          peer,
          request,
          parseWorkspaceUploadOpen(request.params),
          async (params) => {
            await this.seams.assertSession(params.sessionId)
            if (!this.seams.openWorkspaceUpload) {
              throw new RemoteProtocolError(
                'INVALID_REQUEST',
                'workspace.upload is not supported by this host',
              )
            }
            return this.seams.openWorkspaceUpload(peer.deviceId, params)
          },
        )
      case 'workspace.upload.chunk': {
        // Chunk retries are deduplicated O(1) by (uploadId, offset, chunkSha256) in WorkspaceUploadManager
        // rather than pinning multi-kilobyte base64 payloads inside IdempotencyStore.
        const params = parseWorkspaceUploadChunk(request.params)
        if (!this.seams.appendWorkspaceUploadChunk) {
          throw new RemoteProtocolError(
            'INVALID_REQUEST',
            'workspace.upload is not supported by this host',
          )
        }
        return this.seams.appendWorkspaceUploadChunk(peer.deviceId, params)
      }
      case 'workspace.upload.commit':
        return this.mutate(
          peer,
          request,
          parseWorkspaceUploadCommit(request.params),
          async (params) => {
            if (!this.seams.commitWorkspaceUpload) {
              throw new RemoteProtocolError(
                'INVALID_REQUEST',
                'workspace.upload is not supported by this host',
              )
            }
            return this.seams.commitWorkspaceUpload(peer.deviceId, params)
          },
        )
      case 'workspace.upload.abort':
        return this.mutate(
          peer,
          request,
          parseWorkspaceUploadAbort(request.params),
          async (params) => {
            if (!this.seams.abortWorkspaceUpload) {
              throw new RemoteProtocolError(
                'INVALID_REQUEST',
                'workspace.upload is not supported by this host',
              )
            }
            return this.seams.abortWorkspaceUpload(peer.deviceId, params)
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
    const liveState = await this.seams.getSessionLiveState?.(params.sessionId)
    const buffer = this.replayBySession.get(params.sessionId)
    if (!buffer) {
      if (params.afterSeq !== undefined) {
        return {
          kind: 'reset',
          reason: 'window-unavailable',
          ...(liveState !== undefined ? { liveState } : {}),
        }
      }
      return {
        kind: 'events',
        events: [],
        ...(liveState !== undefined ? { liveState } : {}),
      }
    }

    // Refresh insertion order on attach as well as on event receipt.
    this.replayBySession.delete(params.sessionId)
    this.replayBySession.set(params.sessionId, buffer)
    const resumed = buffer.resume(params.afterSeq)
    const maxAttachEventBytes = 40 * 1024
    if (resumed.kind === 'events' && params.afterSeq !== undefined && resumed.events.length > 0) {
      if (Buffer.byteLength(JSON.stringify(resumed.events), 'utf8') > maxAttachEventBytes) {
        return {
          kind: 'reset',
          reason: 'window-exceeded',
          oldestSeq: buffer.getOldestSeq() ?? buffer.getLatestSeq(),
          latestSeq: buffer.getLatestSeq(),
          ...(liveState !== undefined ? { liveState } : {}),
        }
      }
    }
    if (resumed.kind === 'events' && params.afterSeq === undefined && resumed.events.length > 0) {
      let trimmed = resumed.events
      let truncatedHead = false
      while (trimmed.length > 1 && Buffer.byteLength(JSON.stringify(trimmed), 'utf8') > maxAttachEventBytes) {
        const dropCount = Math.max(1, Math.floor(trimmed.length / 4))
        trimmed = trimmed.slice(dropCount)
        truncatedHead = true
      }
      if (trimmed.length === 1 && Buffer.byteLength(JSON.stringify(trimmed), 'utf8') > maxAttachEventBytes) {
        trimmed = []
        truncatedHead = true
      }
      if (truncatedHead) {
        const adjustedLiveState = liveState
          ? { ...liveState, hasMoreHistory: true }
          : undefined
        return {
          kind: 'events',
          events: trimmed,
          ...(adjustedLiveState !== undefined ? { liveState: adjustedLiveState } : {}),
        }
      }
    }
    return liveState !== undefined ? { ...resumed, liveState } : resumed
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
