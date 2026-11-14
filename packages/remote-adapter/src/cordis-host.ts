import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DeviceRecord } from './crypto/device-trust.js'
import { RemoteCryptoError } from './crypto/errors.js'
import { PairingCoordinator, type PairingConfirmationParams, type PairingResult } from './crypto/pairing-coordinator.js'
import {
  MAX_PAIRING_TTL_MS,
  PairingTokenRegistry,
  type PairingCandidateView,
} from './crypto/pairing-token.js'
import type { NoiseResponderSession } from './crypto/noise.js'
import { RemoteProtocolError } from './errors.js'
import {
  assertOutsideOfficialDshHome,
  defaultRemoteConfigDir,
  defaultRemoteDshHome,
  openPersistentRemoteStores,
  type PersistentRemoteStores,
} from './stores.js'

export {
  assertOutsideOfficialDshHome,
  defaultRemoteConfigDir,
  defaultRemoteDshHome,
  openPersistentRemoteStores,
  type PersistentRemoteStores,
}
import { DshAgentBackend } from './backends/dsh-backend.js'
import { MultiAgentHostRouter } from './backends/multi-agent-router.js'
import { boundSessionListPayload, type ManagedAgentBackend } from './backends/types.js'
import { RemoteHostRuntime, type RemoteHostRuntimeOptions } from './host-runtime.js'
import {
  REMOTE_PROTOCOL_VERSION,
  type AgentEngineId,
  type AgentHostBackend,
  type Capability,
  type CreateSessionParams,
  type EngineDescriptor,
  type FollowupOptions,
  type ModelCatalogResult,
  type ModelOptionRef,
  type ModelSelectionParams,
  type OfficialRemoteSeams,
  type PendingApprovalSnapshot,
  type PendingQuestionSnapshot,
  type PromptImageAttachment,
  type ReasoningEffortOption,
  type RemoteCommandDescriptor,
  type RemoteSkillSummary,
  type SessionForkParams,
  type SessionHistoryParams,
  type SessionHistoryResult,
  type SessionLiveStateSnapshot,
  type SessionRef,
  type SessionSearchParams,
  type SessionSearchResult,
  type WorkspaceGitDiffParams,
  type WorkspaceGitDiffResult,
  type WorkspaceGitStatusParams,
  type WorkspaceGitStatusResult,
  type WorkspaceUploadAbortParams,
  type WorkspaceUploadAbortResult,
  type WorkspaceUploadChunkParams,
  type WorkspaceUploadChunkResult,
  type WorkspaceUploadCommitParams,
  type WorkspaceUploadCommitResult,
  type WorkspaceUploadOpenParams,
  type WorkspaceUploadOpenResult,
} from './protocol.js'
import {
  buildAttachLiveStateSnapshot,
  foldNormalizedSessionEvents,
  type FoldedSessionEventsSummary,
} from './session-state-fold.js'
import { truncateByCodePoints } from './unicode.js'
import { WorkspaceUploadManager } from './workspace-upload.js'
import {
  findOfficialSessionTranscriptPath,
  isSafeSessionId,
  paginateNormalizedTranscriptEvents,
  readDecodedOfficialTranscript,
  searchSessionCollections,
  type DecodedOfficialSessionTranscript,
  type NormalizedTranscriptEvent,
} from './session-transcript.js'
import {
  createPairingBootstrapDescriptor,
  encodePairingDeepLink,
  type PairingBootstrapDescriptor,
} from './carrier/pairing-qr.js'
import type { HostLanCarrierOptions } from './carrier/lan-host.js'
import type { HostRelayCarrierOptions } from './carrier/relay-host.js'
import type { HostWebRtcCarrierOptions } from './carrier/webrtc-host.js'

const CANONICAL_SESSION_LOG_RE = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/u
const DEFAULT_GRANTED_CAPABILITIES: readonly Capability[] = Object.freeze([
  'observe',
  'prompt',
  'approve',
  'answer-question',
])

export interface OfficialAgentContextLike {
  on(event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }): () => void
}

export interface OfficialAgentLike {
  readonly id: string
  readonly status?: string
  readonly options?: { readonly provider?: string; readonly model?: string }
  readonly model?: {
    current?(): ModelSelectionParams | undefined
    select?(selection: ModelSelectionParams): void
  }
  readonly session?: {
    readonly id?: string
    readonly log?: readonly unknown[]
    append?(type: string, data: unknown): unknown
  }
  readonly ctx: OfficialAgentContextLike
  followup(message: Record<string, unknown>): void
  steer?(message: Record<string, unknown>): void
  cancel?(
    cause:
      | { readonly kind: 'user' | 'parent' | 'disposed' }
      | { readonly kind: 'hook'; readonly reason: string }
      | string,
    options?: { readonly keepInbox?: boolean | undefined },
  ): void
  whenIdle?(): Promise<void>
}

export interface OfficialAgentHandleLike {
  readonly agent: OfficialAgentLike
  dispose(): Promise<void>
}

export interface OfficialCordisContextLike {
  readonly agents: {
    create(options: {
      readonly sessionId: string
      readonly meta?: Record<string, unknown>
      readonly seed?: readonly unknown[]
      readonly inheritedEventCount?: number
      readonly agentOptions?: Record<string, unknown>
      readonly setup?: (agentCtx: OfficialAgentContextLike, agent: OfficialAgentLike) => unknown
    }): Promise<OfficialAgentHandleLike>
    resume(options: {
      readonly resumeSessionId: string
      readonly agentOptions?: Record<string, unknown>
      readonly setup?: (agentCtx: OfficialAgentContextLike, agent: OfficialAgentLike) => unknown
    }): Promise<OfficialAgentHandleLike>
    get(id: string): OfficialAgentLike | undefined
    list(): readonly OfficialAgentLike[]
  }
  readonly agentDefaultModel?: {
    currentSelection(): { readonly provider?: string; readonly model?: string }
  }
  readonly userQuestions?: {
    registerProvider?(provider: { ask(request: Record<string, unknown>): Promise<unknown> }): () => void
  }
  readonly sessions?: {
    flush?(session: unknown): Promise<void>
  }
  readonly commands?: {
    list?(agent: OfficialAgentLike): readonly {
      readonly name: string
      readonly description: string
      readonly inputHint?: string
      readonly acceptsAttachments?: boolean
    }[]
    find?(agent: OfficialAgentLike, name: string): unknown
    execute?(
      agent: OfficialAgentLike,
      line: string,
      submittedAttachments?: readonly unknown[],
      signal?: AbortSignal,
    ): Promise<unknown>
  }
  readonly skills?: {
    list?(): readonly {
      readonly name: string
      readonly description: string
      readonly whenToUse?: string
      readonly source?: string
    }[]
  }
  on?(event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }): () => void
  parallel?(event: string, ...args: unknown[]): Promise<unknown>
  get?(name: string): unknown
}

export interface PairingIssueResult {
  readonly descriptor: PairingBootstrapDescriptor
  readonly pairingJson: string
  readonly deepLink: string
  readonly tokenHash: string
  readonly expiresAt: number
}

export interface BridgeControlServerHandle {
  readonly url: string
  readonly controlToken: string
  close(): Promise<void>
}

export interface RemoteControlBridgeLike {
  readonly pairingCoordinator: ObservablePairingCoordinator
  getStatus(): Promise<unknown>
  listSessions(): Promise<readonly SessionRef[]>
  createSession(options?: CreateSessionParams): Promise<SessionRef>
  listEngines?(): Promise<readonly EngineDescriptor[]>
  getWorkspaceGitStatus?(params: WorkspaceGitStatusParams): Promise<WorkspaceGitStatusResult>
  getWorkspaceGitDiff?(params: WorkspaceGitDiffParams): Promise<WorkspaceGitDiffResult>
  resetSessionStream(sessionId: string, reason?: string): void
  issuePairingDescriptor(options?: {
    readonly ttlMs?: number | undefined
    readonly allowedCapabilities?: readonly Capability[] | undefined
    readonly endpointUrl?: string | undefined
  }): Promise<PairingIssueResult>
  listTrustedDevices(): Promise<readonly DeviceRecord[]>
  revokeDevice(deviceId: string): Promise<boolean>
  stop(): Promise<void>
}

export interface OfficialHostCordisBridgeOptions {
  readonly ctx: OfficialCordisContextLike
  readonly configDir?: string | undefined
  readonly dshHome?: string | undefined
  readonly sessionRoot?: string | undefined
  readonly cwd?: string | undefined
  readonly listPersistedSessions?: (() => Promise<readonly SessionRef[]> | readonly SessionRef[]) | undefined
  readonly extraBackends?: readonly ManagedAgentBackend[] | undefined
  readonly defaultEngine?: AgentEngineId | undefined
  readonly carrier?: Omit<
    HostLanCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  > | undefined
  readonly webrtc?: Omit<
    HostWebRtcCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  > | undefined
  readonly relay?: Omit<
    HostRelayCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  > | undefined
  readonly coreOptions?: RemoteHostRuntimeOptions['coreOptions'] | undefined
  readonly pairingTtlMs?: number | undefined
  readonly signalingUrlHint?: string | undefined
  readonly signalingRoomIdHint?: string | undefined
  readonly stunUrlsHint?: readonly string[] | undefined
  readonly relayUrlHint?: string | undefined
  readonly relayRoomIdHint?: string | undefined
  readonly onPairingCandidate?: ((candidate: PairingCandidateView) => void) | undefined
  readonly autoConfirmCapabilities?: readonly Capability[] | undefined
  readonly clock?: (() => number) | undefined
}

export class ObservablePairingCoordinator extends PairingCoordinator {
  private readonly pending = new Map<string, PairingCandidateView>()
  private readonly listeners = new Set<(candidate: PairingCandidateView) => void>()

  subscribeCandidates(listener: (candidate: PairingCandidateView) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  listPendingCandidates(): readonly PairingCandidateView[] {
    return Object.freeze([...this.pending.values()])
  }

  override async initiatePairing(
    responder: NoiseResponderSession,
    payload: {
      token: string
      displayName?: string
      requestedCapabilities?: readonly Capability[]
      claimedDeviceId?: string
    },
  ): Promise<PairingCandidateView> {
    const view = await super.initiatePairing(responder, payload)
    this.pending.set(view.candidateId, view)
    for (const listener of this.listeners) {
      try {
        listener(view)
      } catch {
        // Observer isolation
      }
    }
    return view
  }

  override async confirmPairing(params: PairingConfirmationParams): Promise<PairingResult> {
    try {
      const result = await super.confirmPairing(params)
      this.pending.delete(params.candidateId)
      return result
    } catch (err) {
      this.pending.delete(params.candidateId)
      throw err
    }
  }

  override async rejectPairing(candidateId: string): Promise<boolean> {
    this.pending.delete(candidateId)
    return super.rejectPairing(candidateId)
  }
}

function readHeaderTitleFromJsonl(filePath: string): string | undefined {
  if (filePath.endsWith('.zstd') || filePath.endsWith('.zst')) {
    const decoded = readDecodedOfficialTranscript(filePath)
    return decoded?.title ?? decoded?.cwd
  }
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const fileSize = fstatSync(fd).size

    // Prefer the latest logged session/title update near the tail if present.
    if (fileSize > 0) {
      const tailLen = Math.min(fileSize, 32 * 1024)
      const tailOffset = fileSize - tailLen
      const tailBuf = Buffer.allocUnsafe(tailLen)
      const tailRead = readSync(fd, tailBuf, 0, tailLen, tailOffset)
      if (tailRead > 0) {
        const tailText = tailBuf.subarray(0, tailRead).toString('utf8')
        if (tailText.includes('"session/title"')) {
          const lines = tailText.split('\n')
          for (let i = lines.length - 1; i >= 0; i -= 1) {
            const line = lines[i]?.trim()
            if (!line || !line.startsWith('{')) continue
            try {
              const ev = JSON.parse(line) as Record<string, unknown>
              if (ev.type === 'session/title') {
                const data = asRecord(ev.data)
                const renamed =
                  typeof data?.title === 'string'
                    ? data.title.trim()
                    : typeof ev.title === 'string'
                      ? ev.title.trim()
                      : undefined
                if (renamed && renamed.length > 0) {
                  return renamed
                }
              }
            } catch {
              // Ignore partial first line when reading from tailOffset > 0.
            }
          }
        }
      }
    }

    const buf = Buffer.allocUnsafe(16 * 1024)
    const bytesRead = readSync(fd, buf, 0, buf.byteLength, 0)
    if (bytesRead <= 0) return undefined
    const slice = buf.subarray(0, bytesRead)
    const nlIndex = slice.indexOf(0x0a)
    if (nlIndex === -1 && bytesRead === buf.byteLength) {
      return undefined
    }
    const firstLine = slice
      .subarray(0, nlIndex >= 0 ? nlIndex : bytesRead)
      .toString('utf8')
      .trim()
    if (!firstLine) return undefined
    const parsed = JSON.parse(firstLine) as Record<string, unknown>
    const meta = (typeof parsed.meta === 'object' && parsed.meta !== null)
      ? parsed.meta as Record<string, unknown>
      : parsed
    const cwd = typeof meta.cwd === 'string' ? meta.cwd.trim() : undefined
    const id = typeof parsed.id === 'string' ? parsed.id.trim() : undefined
    if (cwd && cwd.length > 0) return cwd
    return id
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

const MAX_SESSION_METADATA_CACHE = 512

function findBestCanonicalSessionLog(dirPath: string): string | undefined {
  let files: string[]
  try {
    files = readdirSync(dirPath)
  } catch {
    return undefined
  }
  let bestFile: string | undefined
  let bestVersion = -1
  for (const file of files) {
    const match = CANONICAL_SESSION_LOG_RE.exec(file)
    if (!match) continue
    const ver = match[1] ? Number(match[1]) : 0
    if (ver >= bestVersion) {
      bestVersion = ver
      bestFile = file
    }
  }
  return bestFile ? join(dirPath, bestFile) : undefined
}

export function listOfficialSessionRefsFromRoot(sessionRoot: string): SessionRef[] {
  if (!existsSync(sessionRoot)) return []
  let topEntries
  try {
    topEntries = readdirSync(sessionRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const found = new Map<string, { id: string; title?: string; mtimeMs: number }>()

  const recordDir = (sessionId: string, dirPath: string, fallbackTitle?: string): void => {
    const fullLog = findBestCanonicalSessionLog(dirPath)
    if (!fullLog) return
    let mtimeMs = 0
    try {
      mtimeMs = statSync(fullLog).mtimeMs
    } catch {
      return
    }
    const title = readHeaderTitleFromJsonl(fullLog) ?? fallbackTitle
    const prev = found.get(sessionId)
    if (!prev || mtimeMs > prev.mtimeMs) {
      found.set(sessionId, {
        id: sessionId,
        ...(title !== undefined ? { title } : {}),
        mtimeMs,
      })
    }
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue
    const entryPath = join(sessionRoot, entry.name)
    // Support both flat `<root>/<sessionId>/session*.jsonl` and official
    // `<root>/<projectKey>/<sessionId>/session*.jsonl[.zstd]` layouts.
    if (findBestCanonicalSessionLog(entryPath)) {
      recordDir(entry.name, entryPath)
      continue
    }
    let children
    try {
      children = readdirSync(entryPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      recordDir(child.name, join(entryPath, child.name), entry.name)
    }
  }

  const sorted = [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
  return sorted.map((item) =>
    item.title !== undefined ? { id: item.id, title: item.title } : { id: item.id },
  )
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

interface PendingApproval {
  readonly callId: string
  readonly sessionId: string
  readonly toolName: string
  readonly reason?: string | undefined
  resolve(outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'): void
  cleanup(): void
}

interface PendingQuestion {
  readonly questionId: string
  readonly sessionId: string
  readonly questions: readonly Record<string, unknown>[]
  resolve(answer: { answers: Array<{ id: string; selected: string[]; custom?: string }> }): void
  reject(error: Error): void
  cleanup(): void
}

interface BridgedSessionState {
  readonly id: string
  handle: OfficialAgentHandleLike | undefined
  agent: OfficialAgentLike
  highestOfficialSeq: number
  nextNormalizedSeq: number
  readonly unsubscribes: Array<() => void>
}

export class OfficialHostCordisBridge {
  readonly stores: PersistentRemoteStores
  readonly tokenRegistry: PairingTokenRegistry
  readonly pairingCoordinator: ObservablePairingCoordinator
  readonly dshBackend: DshAgentBackend
  readonly router: MultiAgentHostRouter
  readonly runtime: RemoteHostRuntime

  private readonly ctx: OfficialCordisContextLike
  private readonly dshHome: string
  private readonly sessionRoot: string
  private readonly cwd: string
  private readonly options: OfficialHostCordisBridgeOptions
  private readonly bridgedSessions = new Map<string, BridgedSessionState>()
  private readonly ownedHandles = new Map<string, OfficialAgentHandleLike>()
  private readonly sessionTitleOverrides = new Map<string, string>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private readonly transcriptCache = new Map<
    string,
    { readonly mtimeMs: number; readonly decoded: DecodedOfficialSessionTranscript; readonly eventCount: number }
  >()
  private transcriptCacheEvents = 0
  private readonly liveLogCache = new Map<
    string,
    {
      readonly logRef: readonly unknown[]
      readonly rawLength: number
      readonly lastItemRef: unknown
      readonly filteredLog: readonly unknown[]
      readonly normalizedEvents: readonly NormalizedTranscriptEvent[]
      readonly folded: FoldedSessionEventsSummary
    }
  >()
  private readonly workspaceUploads = new WorkspaceUploadManager()
  private readonly bridgedStatusBySession = new Map<string, 'running' | 'idle'>()
  private readonly rootUnsubscribes: Array<() => void> = []
  private readonly seenEvents = { ingested: 0, approvals: 0, questions: 0, followups: 0 }
  private started = false
  private stopped = false

  constructor(options: OfficialHostCordisBridgeOptions) {
    this.options = options
    this.ctx = options.ctx
    this.dshHome = options.dshHome ? resolve(options.dshHome) : defaultRemoteDshHome()
    this.sessionRoot = options.sessionRoot
      ? resolve(options.sessionRoot)
      : join(this.dshHome, 'sessions')
    this.cwd = options.cwd ?? process.cwd()

    this.stores = openPersistentRemoteStores({
      configDir: options.configDir,
      dshHome: this.dshHome,
      clock: options.clock,
    })

    this.tokenRegistry = new PairingTokenRegistry(
      16,
      options.pairingTtlMs ?? MAX_PAIRING_TTL_MS,
      MAX_PAIRING_TTL_MS,
      options.clock ? { clock: options.clock } : undefined,
    )
    this.pairingCoordinator = new ObservablePairingCoordinator(
      this.stores.hostIdentityStore,
      this.stores.trustStore,
      this.tokenRegistry,
      options.clock ? { clock: options.clock } : undefined,
    )

    if (options.onPairingCandidate || options.autoConfirmCapabilities) {
      const unsub = this.pairingCoordinator.subscribeCandidates((candidate) => {
        options.onPairingCandidate?.(candidate)
        if (options.autoConfirmCapabilities) {
          const allowedSet = new Set(candidate.maxAllowedCapabilities)
          const granted = options.autoConfirmCapabilities.filter((c) => allowedSet.has(c))
          void this.pairingCoordinator
            .confirmPairing({
              candidateId: candidate.candidateId,
              grantedCapabilities: granted.length > 0 ? granted : ['observe'],
            })
            .catch(() => {})
        }
      })
      this.rootUnsubscribes.push(unsub)
    }

    const dshSeams: AgentHostBackend = {
      listSessions: () => this.listDshSessions(),
      assertSession: (sessionId) => this.assertSession(sessionId),
      followup: (sessionId, prompt, options) => this.followup(sessionId, prompt, options),
      respondApproval: (callId, decision) => this.respondApproval(callId, decision),
      respondQuestion: (questionId, answer) => this.respondQuestion(questionId, answer),
      createSession: (options) => this.createDshSession(options),
      renameSession: (sessionId, title) => this.renameSession(sessionId, title),
      abortTurn: (sessionId, options) => this.abortTurn(sessionId, options),
      listModels: (sessionId) => this.listModels(sessionId),
      selectModel: (sessionId, selection) => this.selectModel(sessionId, selection),
      getSessionLiveState: (sessionId) => this.getSessionLiveState(sessionId),
      getSessionHistory: (params) => this.getSessionHistory(params),
      forkSession: (params) => this.forkSession(params),
      searchSessions: (params) => this.searchSessions(params),
      listCommands: (sessionId) => this.listCommands(sessionId),
      executeCommand: (sessionId, command) => this.executeCommand(sessionId, command),
      listSkills: (sessionId) => this.listSkills(sessionId),
      openWorkspaceUpload: (deviceId, params) => this.openWorkspaceUpload(deviceId, params),
      appendWorkspaceUploadChunk: (deviceId, params) => this.appendWorkspaceUploadChunk(deviceId, params),
      commitWorkspaceUpload: (deviceId, params) => this.commitWorkspaceUpload(deviceId, params),
      abortWorkspaceUpload: (deviceId, params) => this.abortWorkspaceUpload(deviceId, params),
    }

    this.dshBackend = new DshAgentBackend({
      seams: dshSeams,
      defaultCwd: this.cwd,
    })

    this.router = new MultiAgentHostRouter({
      backends: [this.dshBackend, ...(options.extraBackends ?? [])],
      defaultEngine: options.defaultEngine ?? 'dsh',
      defaultCwd: this.cwd,
    })

    const seams: OfficialRemoteSeams = this.router

    this.runtime = new RemoteHostRuntime({
      seams,
      trustStore: this.stores.trustStore,
      hostIdentityStore: this.stores.hostIdentityStore,
      pairingCoordinator: this.pairingCoordinator,
      ...(options.coreOptions !== undefined ? { coreOptions: options.coreOptions } : {}),
      carrier: options.carrier ?? {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
      },
      ...(options.webrtc !== undefined ? { webrtc: options.webrtc } : {}),
      ...(options.relay !== undefined ? { relay: options.relay } : {}),
    })

    const unsubRouterEvents = this.router.onEvent((sessionId, events) => {
      this.runtime.ingestSessionEventBatch(sessionId, { log: events })
    })
    this.rootUnsubscribes.push(unsubRouterEvents)
  }

  async start(): Promise<void> {
    if (this.started) return
    await this.stores.hostIdentityStore.loadOrCreate()
    await this.awaitCordisLoader()
    this.installRootListeners()
    await this.router.start()
    await this.runtime.start()
    this.started = true
  }

  private async awaitCordisLoader(): Promise<void> {
    const loader = this.ctx.get?.('loader')
    if (loader && typeof (loader as { await?: unknown }).await === 'function') {
      await (loader as { await(): Promise<void> }).await()
    }
  }

  private defaultAgentOptions(): Record<string, unknown> {
    const selection = this.ctx.agentDefaultModel?.currentSelection()
    if (!selection) return {}
    return {
      ...(selection.provider !== undefined ? { provider: selection.provider } : {}),
      ...(selection.model !== undefined ? { model: selection.model } : {}),
    }
  }

  private installRootListeners(): void {
    if (typeof this.ctx.on === 'function') {
      const unsubApproval = this.ctx.on('approval/request', (request: unknown, next: () => Promise<string>) => {
        const req = asRecord(request)
        const agent = req ? asRecord(req.agent) : undefined
        const agentId = typeof agent?.id === 'string' ? agent.id : undefined
        if (!agentId || !this.bridgedSessions.has(agentId)) {
          return next()
        }
        const signal = req?.signal as AbortSignal | undefined
        if (this.stopped || signal?.aborted) {
          return Promise.resolve('cancelled')
        }
        const callId =
          typeof req?.callId === 'string' && req.callId.length > 0 ? req.callId : randomUUID()
        const toolName =
          typeof req?.toolName === 'string' && req.toolName.length > 0 ? req.toolName : 'tool'
        const reason = typeof req?.reason === 'string' ? req.reason : undefined

        return new Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>((resolve) => {
          const onAbort = (): void => {
            const existing = this.pendingApprovals.get(callId)
            if (!existing) return
            this.pendingApprovals.delete(callId)
            existing.cleanup()
            resolve('cancelled')
          }
          if (signal && typeof signal.addEventListener === 'function') {
            signal.addEventListener('abort', onAbort, { once: true })
          }
          this.pendingApprovals.set(callId, {
            callId,
            sessionId: agentId,
            toolName,
            ...(reason !== undefined ? { reason } : {}),
            resolve,
            cleanup: () => {
              if (signal && typeof signal.removeEventListener === 'function') {
                signal.removeEventListener('abort', onAbort)
              }
            },
          })

          this.emitNormalizedEvent(agentId, 'approval.request', {
            callId,
            toolName,
            ...(reason !== undefined ? { reason } : {}),
          })
        })
      })
      this.rootUnsubscribes.push(unsubApproval)

      const unsubQuestion = this.ctx.on(
        'user-questions/request',
        (request: unknown, next: () => Promise<unknown>) => {
          const req = asRecord(request)
          const agent = req ? asRecord(req.agent) : undefined
          const agentId = typeof agent?.id === 'string' ? agent.id : undefined
          if (!agentId || !this.bridgedSessions.has(agentId)) {
            return next()
          }
          const signal = req?.signal as AbortSignal | undefined
          if (this.stopped || signal?.aborted) {
            return Promise.reject(new Error('question request aborted (ASK_ABORTED)'))
          }
          const wait = req ? asRecord(req.wait) : undefined
          const questionId =
            typeof wait?.callId === 'string' && wait.callId.length > 0
              ? wait.callId
              : randomUUID()
          const questions = Array.isArray(req?.questions)
            ? (req.questions as Record<string, unknown>[])
            : []

          return new Promise((resolve, reject) => {
            const onAbort = (): void => {
              const existing = this.pendingQuestions.get(questionId)
              if (!existing) return
              this.pendingQuestions.delete(questionId)
              existing.cleanup()
              reject(new Error('question request aborted (ASK_ABORTED)'))
            }
            if (signal && typeof signal.addEventListener === 'function') {
              signal.addEventListener('abort', onAbort, { once: true })
            }
            this.pendingQuestions.set(questionId, {
              questionId,
              sessionId: agentId,
              questions,
              resolve,
              reject,
              cleanup: () => {
                if (signal && typeof signal.removeEventListener === 'function') {
                  signal.removeEventListener('abort', onAbort)
                }
              },
            })

            this.emitNormalizedEvent(agentId, 'question.request', {
              questionId,
              questions,
            })
          })
        },
      )
      this.rootUnsubscribes.push(unsubQuestion)
    }

    if (typeof this.ctx.userQuestions?.registerProvider === 'function') {
      const unsubProvider = this.ctx.userQuestions.registerProvider({
        ask: (request) => {
          const req = asRecord(request)
          const agent = req ? asRecord(req.agent) : undefined
          const agentId =
            (typeof agent?.id === 'string' ? agent.id : undefined) ??
            this.bridgedSessions.keys().next().value
          if (!agentId) {
            return Promise.reject(new Error('no active remote session for question'))
          }
          const wait = req ? asRecord(req.wait) : undefined
          const questionId =
            typeof wait?.callId === 'string' && wait.callId.length > 0
              ? wait.callId
              : randomUUID()
          const questions = Array.isArray(req?.questions)
            ? (req.questions as Record<string, unknown>[])
            : []
          return new Promise((resolve, reject) => {
            this.pendingQuestions.set(questionId, {
              questionId,
              sessionId: agentId,
              questions,
              resolve,
              reject,
              cleanup: () => {},
            })
            this.emitNormalizedEvent(agentId, 'question.request', {
              questionId,
              questions,
            })
          })
        },
      })
      this.rootUnsubscribes.push(unsubProvider)
    }
  }

  private emitNormalizedEvent(
    sessionId: string,
    type: string,
    data?: unknown,
    options?: { readonly broadcast?: boolean | undefined },
  ): void {
    const entry = this.bridgedSessions.get(sessionId)
    if (!entry) return
    entry.nextNormalizedSeq += 1
    const seq = entry.nextNormalizedSeq
    const item = data !== undefined ? { seq, type, data } : { seq, type }
    this.runtime.ingestSessionEventBatch(sessionId, { log: [item] }, options)
    this.seenEvents.ingested += 1
  }

  private ingestOfficialEvent(
    sessionId: string,
    raw: unknown,
    options?: { readonly broadcast?: boolean | undefined },
  ): void {
    const entry = this.bridgedSessions.get(sessionId)
    const event = asRecord(raw)
    if (!entry || !event || typeof event.type !== 'string' || event.type.length === 0) return

    if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq)) {
      if (event.seq <= entry.highestOfficialSeq) return
      entry.highestOfficialSeq = event.seq
    }

    let payloadData: unknown = event.data
    if (payloadData === undefined) {
      const rest: Record<string, unknown> = {}
      let hasExtra = false
      for (const [k, v] of Object.entries(event)) {
        if (k === 'seq' || k === 'type' || k === 'time') continue
        rest[k] = v
        hasExtra = true
      }
      if (hasExtra) payloadData = rest
    }

    if (event.type === 'turn/start') {
      this.bridgedStatusBySession.set(sessionId, 'running')
    } else if (event.type === 'turn/end') {
      this.bridgedStatusBySession.set(sessionId, 'idle')
    } else if (event.type === 'agent/status') {
      const rec = asRecord(payloadData)
      if (rec?.status === 'running' || rec?.status === 'idle') {
        this.bridgedStatusBySession.set(sessionId, rec.status)
      }
    }

    this.emitNormalizedEvent(sessionId, event.type, payloadData, options)
  }

  private attachAgentListeners(
    sessionId: string,
    agent: OfficialAgentLike,
    handle?: OfficialAgentHandleLike,
  ): BridgedSessionState {
    const existing = this.bridgedSessions.get(sessionId)
    if (existing && existing.agent === agent) {
      if (handle && !existing.handle) existing.handle = handle
      return existing
    }
    if (existing) {
      for (const unsub of existing.unsubscribes) unsub()
      this.bridgedSessions.delete(sessionId)
    }

    const state: BridgedSessionState = {
      id: sessionId,
      handle,
      agent,
      highestOfficialSeq: -1,
      nextNormalizedSeq: 0,
      unsubscribes: [],
    }
    this.bridgedSessions.set(sessionId, state)

    if (Array.isArray(agent.session?.log)) {
      for (const item of agent.session.log) {
        this.ingestOfficialEvent(sessionId, item, { broadcast: false })
      }
    }
    if (state.nextNormalizedSeq === 0) {
      const diskTranscript = this.readCachedTranscript(sessionId)
      if (diskTranscript) {
        for (const item of diskTranscript.rawEvents) {
          this.ingestOfficialEvent(sessionId, item, { broadcast: false })
        }
      }
    }

    const unsubSessionEvent = agent.ctx.on('session/event', (arg1: unknown, arg2: unknown) => {
      if (arg2 !== undefined) {
        this.ingestOfficialEvent(sessionId, arg2)
        return
      }
      const batch = asRecord(arg1)
      if (batch && Array.isArray(batch.log)) {
        for (const item of batch.log) {
          this.ingestOfficialEvent(sessionId, item)
        }
        return
      }
      this.ingestOfficialEvent(sessionId, arg1)
    })
    state.unsubscribes.push(unsubSessionEvent)

    const unsubStream = agent.ctx.on('agent/assistant-stream', (payload: unknown) => {
      const obj = asRecord(payload)
      const frame = obj ? asRecord(obj.frame) : undefined
      if (!frame || frame.type !== 'chunk' || !frame.chunk) return
      this.emitNormalizedEvent(sessionId, 'assistant/chunk', {
        chunk: frame.chunk,
        ...(frame.turn !== undefined ? { turn: frame.turn } : {}),
        ...(frame.step !== undefined ? { step: frame.step } : {}),
        ...(frame.index !== undefined ? { index: frame.index } : {}),
      })
    })
    state.unsubscribes.push(unsubStream)

    const unsubError = agent.ctx.on('agent/error', (payload: unknown) => {
      const obj = asRecord(payload)
      const err = obj?.error
      const message = err instanceof Error ? err.message : String(err ?? 'agent error')
      this.emitNormalizedEvent(sessionId, 'agent/error', {
        message,
        ...(obj?.turn !== undefined ? { turn: obj.turn } : {}),
        ...(obj?.step !== undefined ? { step: obj.step } : {}),
      })
    })
    state.unsubscribes.push(unsubError)

    const unsubStatus = agent.ctx.on('agent/status', (payload: unknown) => {
      const rec = asRecord(payload)
      const status = typeof rec?.status === 'string' ? rec.status : undefined
      if (status === 'idle' || status === 'running') {
        this.setBoundedSessionEntry(this.bridgedStatusBySession, sessionId, status)
        this.emitNormalizedEvent(sessionId, 'agent/status', { status })
      }
    })
    state.unsubscribes.push(unsubStatus)

    return state
  }

  private setBoundedSessionEntry<V>(map: Map<string, V>, sessionId: string, value: V): void {
    map.delete(sessionId)
    map.set(sessionId, value)
    while (map.size > MAX_SESSION_METADATA_CACHE) {
      let evictKey: string | undefined
      for (const candidateKey of map.keys()) {
        if (!this.bridgedSessions.has(candidateKey)) {
          evictKey = candidateKey
          break
        }
      }
      if (evictKey === undefined) {
        evictKey = map.keys().next().value
      }
      if (evictKey === undefined) break
      map.delete(evictKey)
    }
  }

  async createSession(options?: CreateSessionParams): Promise<SessionRef> {
    return this.router.createSession(options)
  }

  private async createDshSession(options?: {
    readonly sessionId?: string | undefined
    readonly cwd?: string | undefined
    readonly title?: string | undefined
  }): Promise<SessionRef> {
    if (options?.sessionId !== undefined && !isSafeSessionId(options.sessionId)) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'sessionId contains invalid path segments or characters')
    }
    const sessionId = options?.sessionId ?? `session-${randomUUID()}`
    const cwd = options?.cwd ?? this.cwd
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd },
      agentOptions: this.defaultAgentOptions(),
      setup: (_agentCtx, agent) => {
        if (agent) {
          this.attachAgentListeners(sessionId, agent)
        }
      },
    })
    await handle.agent.whenIdle?.()
    this.ownedHandles.set(sessionId, handle)
    this.attachAgentListeners(sessionId, handle.agent, handle)
    let title = cwd
    if (options?.title) {
      const titleSvc = this.ctx.get?.('sessionTitle') as
        | { rename?(session: unknown, title: string): { title: string } }
        | undefined
      if (titleSvc?.rename && handle.agent.session) {
        try {
          title = titleSvc.rename(handle.agent.session, options.title).title
        } catch {
          title = options.title
        }
      } else {
        title = options.title
      }
      this.setBoundedSessionEntry(this.sessionTitleOverrides, sessionId, title)
    }
    return { id: sessionId, title }
  }

  async renameSession(sessionId: string, title: string): Promise<SessionRef> {
    const cleanTitle = title.trim()
    if (cleanTitle.length === 0 || cleanTitle.length > 120) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'title must be a 1..120 character string')
    }
    const agent = await this.ensureLiveAgent(sessionId)
    let resolvedTitle = cleanTitle
    const titleSvc = readOptionalService<{
      rename?(session: unknown, nextTitle: string): { title?: string } | string
    }>(this.ctx, 'sessionTitle')
    if (titleSvc?.rename && agent.session) {
      try {
        const res = titleSvc.rename(agent.session, cleanTitle)
        if (typeof res === 'string' && res.trim().length > 0) {
          resolvedTitle = res.trim()
        } else if (res && typeof res === 'object' && typeof res.title === 'string' && res.title.trim().length > 0) {
          resolvedTitle = res.title.trim()
        }
      } catch (err) {
        throw new RemoteProtocolError(
          'INVALID_REQUEST',
          err instanceof Error ? err.message : String(err),
        )
      }
    } else if (typeof agent.session?.append === 'function') {
      try {
        agent.session.append('session/title', { title: cleanTitle, source: 'user' })
      } catch {
        // Fallback to local override when test stub session log does not support append.
      }
    }
    this.setBoundedSessionEntry(this.sessionTitleOverrides, sessionId, resolvedTitle)
    this.emitNormalizedEvent(sessionId, 'session/title', {
      sessionId,
      title: resolvedTitle,
      source: 'user',
    })
    return { id: sessionId, title: resolvedTitle }
  }

  async ensureLiveAgent(sessionId: string): Promise<OfficialAgentLike> {
    const existingBridge = this.bridgedSessions.get(sessionId)
    if (existingBridge) return existingBridge.agent

    const live = this.ctx.agents.get(sessionId)
    if (live) {
      this.attachAgentListeners(sessionId, live)
      return live
    }

    const persisted = await this.findSessionRef(sessionId)
    if (!persisted) {
      throw new RemoteProtocolError('INVALID_REQUEST', `session not found: ${sessionId}`)
    }

    const handle = await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.defaultAgentOptions(),
      setup: (_agentCtx, agent) => {
        if (agent) {
          this.attachAgentListeners(sessionId, agent)
        }
      },
    })
    await handle.agent.whenIdle?.()
    this.ownedHandles.set(sessionId, handle)
    this.attachAgentListeners(sessionId, handle.agent, handle)
    return handle.agent
  }

  private async listPersistedRefs(): Promise<readonly SessionRef[]> {
    if (this.options.listPersistedSessions) {
      return await this.options.listPersistedSessions()
    }
    return listOfficialSessionRefsFromRoot(this.sessionRoot)
  }

  private async findSessionRef(sessionId: string): Promise<SessionRef | undefined> {
    const all = await this.listDshSessions()
    return all.find((s) => s.id === sessionId)
  }

  private readLiveAgentTitle(agent: OfficialAgentLike): string | undefined {
    const log = agent.session?.log
    if (Array.isArray(log)) {
      for (let i = log.length - 1; i >= 0; i -= 1) {
        const rec = asRecord(log[i])
        if (rec?.type === 'session/title') {
          const data = asRecord(rec.data)
          const t =
            typeof data?.title === 'string'
              ? data.title.trim()
              : typeof rec.title === 'string'
                ? rec.title.trim()
                : undefined
          if (t && t.length > 0) return t
        }
      }
    }
    return this.sessionTitleOverrides.get(agent.id)
  }

  private readCachedTranscript(sessionId: string): DecodedOfficialSessionTranscript | undefined {
    if (!isSafeSessionId(sessionId)) return undefined
    const filePath = findOfficialSessionTranscriptPath(this.sessionRoot, sessionId)
    if (!filePath) return undefined
    let mtimeMs = 0
    try {
      mtimeMs = statSync(filePath).mtimeMs
    } catch {
      return undefined
    }
    const cached = this.transcriptCache.get(filePath)
    if (cached && cached.mtimeMs === mtimeMs) {
      this.transcriptCache.delete(filePath)
      this.transcriptCache.set(filePath, cached)
      return cached.decoded
    }
    if (cached) {
      this.transcriptCache.delete(filePath)
      this.transcriptCacheEvents = Math.max(0, this.transcriptCacheEvents - cached.eventCount)
    }
    const decoded = readDecodedOfficialTranscript(filePath, mtimeMs)
    if (!decoded) return undefined
    const eventCount = decoded.normalizedEvents.length
    while (
      this.transcriptCache.size >= 128 ||
      (this.transcriptCache.size > 0 && this.transcriptCacheEvents + eventCount > 250_000)
    ) {
      const oldestKey = this.transcriptCache.keys().next().value
      if (oldestKey === undefined) break
      const evicted = this.transcriptCache.get(oldestKey)
      this.transcriptCache.delete(oldestKey)
      if (evicted) {
        this.transcriptCacheEvents = Math.max(0, this.transcriptCacheEvents - evicted.eventCount)
      }
    }
    this.transcriptCache.set(filePath, { mtimeMs, decoded, eventCount })
    this.transcriptCacheEvents += eventCount
    return decoded
  }

  private getMemoizedLiveSnapshot(
    sessionId: string,
    rawLog: readonly unknown[],
  ): {
    readonly filteredLog: readonly unknown[]
    readonly normalizedEvents: readonly NormalizedTranscriptEvent[]
    readonly folded: FoldedSessionEventsSummary
  } {
    const rawLength = rawLog.length
    const lastItemRef = rawLength > 0 ? rawLog[rawLength - 1] : undefined
    const existing = this.liveLogCache.get(sessionId)
    if (
      existing &&
      existing.logRef === rawLog &&
      existing.rawLength === rawLength &&
      existing.lastItemRef === lastItemRef
    ) {
      this.liveLogCache.delete(sessionId)
      this.liveLogCache.set(sessionId, existing)
      return existing
    }
    const filteredLog = rawLog.filter((item) => {
      const rec = asRecord(item)
      return rec?.type !== 'assistant/chunk'
    })
    const normalizedEvents = this.normalizeLogEvents(filteredLog)
    const folded = foldNormalizedSessionEvents(normalizedEvents)
    const entry = {
      logRef: rawLog,
      rawLength,
      lastItemRef,
      filteredLog,
      normalizedEvents,
      folded,
    }
    if (this.liveLogCache.size >= 64) {
      const oldest = this.liveLogCache.keys().next().value
      if (oldest !== undefined) this.liveLogCache.delete(oldest)
    }
    this.liveLogCache.set(sessionId, entry)
    return entry
  }

  private normalizeLogEvents(
    rawLog: readonly unknown[],
  ): readonly NormalizedTranscriptEvent[] {
    const out: NormalizedTranscriptEvent[] = []
    for (let i = 0; i < rawLog.length; i += 1) {
      const rec = asRecord(rawLog[i])
      if (!rec || typeof rec.type !== 'string' || rec.type.length === 0) continue
      let payloadData: unknown = rec.data
      if (payloadData === undefined) {
        const rest: Record<string, unknown> = {}
        let hasExtra = false
        for (const [k, v] of Object.entries(rec)) {
          if (k === 'seq' || k === 'type' || k === 'time') continue
          rest[k] = v
          hasExtra = true
        }
        if (hasExtra) payloadData = rest
      }
      const eventTime = typeof rec.time === 'number' && Number.isFinite(rec.time) ? rec.time : undefined
      out.push({
        seq: out.length + 1,
        type: rec.type,
        ...(eventTime !== undefined ? { time: eventTime } : {}),
        ...(payloadData !== undefined ? { data: payloadData } : {}),
      })
    }
    return out
  }

  private collectPendingSnapshots(sessionId: string): {
    readonly approvals: readonly PendingApprovalSnapshot[]
    readonly questions: readonly PendingQuestionSnapshot[]
  } {
    const approvals: PendingApprovalSnapshot[] = []
    for (const pending of this.pendingApprovals.values()) {
      if (pending.sessionId !== sessionId) continue
      approvals.push({
        callId: pending.callId,
        toolName: pending.toolName,
        ...(pending.reason !== undefined ? { reason: pending.reason } : {}),
        sessionId: pending.sessionId,
      })
    }
    const questions: PendingQuestionSnapshot[] = []
    for (const pending of this.pendingQuestions.values()) {
      if (pending.sessionId !== sessionId) continue
      const firstQ = pending.questions[0]
      const prompt =
        typeof firstQ?.question === 'string'
          ? firstQ.question
          : typeof firstQ?.prompt === 'string'
            ? firstQ.prompt
            : `Question (${pending.questions.length || 1})`
      questions.push({
        questionId: pending.questionId,
        prompt,
        questions: pending.questions,
        sessionId: pending.sessionId,
      })
    }
    return { approvals, questions }
  }

  private enrichSessionRef(base: SessionRef, agent?: OfficialAgentLike, allowDiskRead = false): SessionRef {
    const overrideTitle = this.sessionTitleOverrides.get(base.id)
    const liveTitle = agent ? this.readLiveAgentTitle(agent) : undefined
    const decoded =
      allowDiskRead || (agent && (!Array.isArray(agent.session?.log) || agent.session.log.length === 0))
        ? this.readCachedTranscript(base.id)
        : undefined
    const liveSnapshot =
      Array.isArray(agent?.session?.log) && agent.session.log.length > 0
        ? this.getMemoizedLiveSnapshot(base.id, agent.session.log)
        : undefined
    const liveLog = liveSnapshot?.normalizedEvents ?? decoded?.normalizedEvents ?? []
    const folded = liveSnapshot
      ? liveSnapshot.folded
      : liveLog.length > 0
        ? foldNormalizedSessionEvents(liveLog)
        : undefined
    const { approvals, questions } = this.collectPendingSnapshots(base.id)
    const liveModel = agent?.model?.current?.() ?? folded?.model
    const status =
      agent !== undefined || this.bridgedSessions.has(base.id)
        ? (this.bridgedStatusBySession.get(base.id) ??
          (agent?.status === 'running' ? 'running' : (folded?.status ?? 'idle')))
        : undefined
    const resolvedTitle = overrideTitle ?? liveTitle ?? folded?.title ?? base.title ?? decoded?.cwd
    const preview = folded?.preview ?? decoded?.preview
    const cwd = decoded?.cwd
    const updatedAtMs = decoded?.mtimeMs && decoded.mtimeMs > 0 ? decoded.mtimeMs : base.updatedAtMs
    return {
      id: base.id,
      ...(resolvedTitle !== undefined ? { title: resolvedTitle } : {}),
      ...(updatedAtMs !== undefined ? { updatedAtMs } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(preview !== undefined ? { preview } : {}),
      ...(liveModel !== undefined ? { model: liveModel } : {}),
      ...(approvals.length > 0 ? { pendingApprovals: approvals.length } : {}),
      ...(questions.length > 0 ? { pendingQuestions: questions.length } : {}),
    }
  }

  async listSessions(): Promise<readonly SessionRef[]> {
    return this.router.listSessions()
  }

  async listEngines(): Promise<readonly EngineDescriptor[]> {
    return this.router.listEngines()
  }

  async getWorkspaceGitStatus(params: WorkspaceGitStatusParams): Promise<WorkspaceGitStatusResult> {
    return this.router.getWorkspaceGitStatus(params)
  }

  async getWorkspaceGitDiff(params: WorkspaceGitDiffParams): Promise<WorkspaceGitDiffResult> {
    return this.router.getWorkspaceGitDiff(params)
  }

  private async listDshSessions(): Promise<readonly SessionRef[]> {
    const merged = new Map<string, SessionRef>()
    const activeIds = new Set<string>()
    const persisted = await this.listPersistedRefs()
    const persistedTitleById = new Map<string, string>()
    for (const ref of persisted) {
      if (ref.title !== undefined) {
        persistedTitleById.set(ref.id, ref.title)
      }
    }
    for (const agent of this.ctx.agents.list()) {
      activeIds.add(agent.id)
      const title =
        this.sessionTitleOverrides.get(agent.id) ??
        this.readLiveAgentTitle(agent) ??
        persistedTitleById.get(agent.id)
      merged.set(agent.id, this.enrichSessionRef(title !== undefined ? { id: agent.id, title } : { id: agent.id }, agent, true))
    }
    for (const state of this.bridgedSessions.values()) {
      activeIds.add(state.id)
      if (!merged.has(state.id)) {
        const title =
          this.sessionTitleOverrides.get(state.id) ??
          this.readLiveAgentTitle(state.agent) ??
          persistedTitleById.get(state.id)
        merged.set(state.id, this.enrichSessionRef(title !== undefined ? { id: state.id, title } : { id: state.id }, state.agent, true))
      }
    }
    let diskEnriched = 0
    for (const ref of persisted) {
      if (!merged.has(ref.id)) {
        const override = this.sessionTitleOverrides.get(ref.id)
        const baseRef = override !== undefined ? { ...ref, title: override } : ref
        const allowDiskRead = diskEnriched < 25
        if (allowDiskRead) diskEnriched += 1
        merged.set(ref.id, this.enrichSessionRef(baseRef, undefined, allowDiskRead))
      }
    }
    return boundSessionListPayload([...merged.values()], activeIds)
  }

  async assertSession(sessionId: string): Promise<void> {
    if (!isSafeSessionId(sessionId)) {
      throw new RemoteProtocolError('INVALID_REQUEST', `invalid sessionId: ${sessionId}`)
    }
    await this.ensureLiveAgent(sessionId)
  }

  private getSessionEventCollection(sessionId: string): {
    readonly source: 'live' | 'disk'
    readonly rawEvents: readonly unknown[]
    readonly normalizedEvents: readonly NormalizedTranscriptEvent[]
    readonly title?: string | undefined
    readonly cwd?: string | undefined
    readonly agent?: OfficialAgentLike | undefined
  } | undefined {
    const live = this.bridgedSessions.get(sessionId)?.agent ?? this.ctx.agents.get(sessionId)
    const disk = this.readCachedTranscript(sessionId)
    if (live && Array.isArray(live.session?.log) && live.session.log.length > 0) {
      const memo = this.getMemoizedLiveSnapshot(sessionId, live.session.log)
      return {
        source: 'live',
        rawEvents: memo.filteredLog,
        normalizedEvents: memo.normalizedEvents,
        title: this.sessionTitleOverrides.get(sessionId) ?? this.readLiveAgentTitle(live) ?? disk?.title,
        cwd: disk?.cwd,
        agent: live,
      }
    }
    if (disk) {
      return {
        source: 'disk',
        rawEvents: disk.rawEvents,
        normalizedEvents: disk.normalizedEvents.filter((e) => e.type !== 'assistant/chunk'),
        title: this.sessionTitleOverrides.get(sessionId) ?? disk.title,
        cwd: disk.cwd,
        agent: live,
      }
    }
    if (live) {
      return {
        source: 'live',
        rawEvents: [],
        normalizedEvents: [],
        title: this.sessionTitleOverrides.get(sessionId) ?? this.readLiveAgentTitle(live),
        agent: live,
      }
    }
    return undefined
  }

  async getSessionLiveState(sessionId: string): Promise<SessionLiveStateSnapshot | undefined> {
    const collection = this.getSessionEventCollection(sessionId)
    const agent = collection?.agent ?? this.bridgedSessions.get(sessionId)?.agent ?? this.ctx.agents.get(sessionId)
    if (!collection && !agent) return undefined

    const events = collection?.normalizedEvents ?? []
    const folded = foldNormalizedSessionEvents(events)
    const liveStatus =
      this.bridgedStatusBySession.get(sessionId) ??
      (agent?.status === 'running' ? 'running' : agent ? folded.status : undefined)
    const liveModel = agent?.model?.current?.()
    const windowInfo = this.runtime.getReplayWindowInfo(sessionId)
    const { approvals, questions } = this.collectPendingSnapshots(sessionId)
    const oldestSeq = windowInfo?.oldestSeq ?? events[0]?.seq ?? null
    const latestSeq = windowInfo?.latestSeq ?? events[events.length - 1]?.seq ?? null
    const hasMoreHistory =
      (oldestSeq !== null && oldestSeq > 1) ||
      (windowInfo !== undefined && events.length > windowInfo.size)

    return buildAttachLiveStateSnapshot({
      folded,
      liveStatus,
      liveModel,
      title: collection?.title,
      pendingApprovals: approvals,
      pendingQuestions: questions,
      oldestSeq,
      latestSeq,
      hasMoreHistory,
    })
  }

  async getSessionHistory(params: SessionHistoryParams): Promise<SessionHistoryResult> {
    const collection = this.getSessionEventCollection(params.sessionId)
    if (!collection) {
      const ref = await this.findSessionRef(params.sessionId)
      if (!ref) {
        throw new RemoteProtocolError('INVALID_REQUEST', `session not found: ${params.sessionId}`)
      }
      return {
        sessionId: params.sessionId,
        events: [],
        hasMore: false,
        oldestSeq: null,
        latestSeq: null,
        source: 'disk',
      }
    }

    const page = paginateNormalizedTranscriptEvents(collection.normalizedEvents, {
      beforeSeq: params.beforeSeq,
      limit: params.limit,
      minTurns: params.minTurns,
      maxBytes: 44 * 1024,
    })
    return {
      sessionId: params.sessionId,
      events: page.events,
      hasMore: page.hasMore,
      oldestSeq: page.oldestSeq,
      latestSeq: page.latestSeq,
      source: collection.source,
    }
  }

  private async buildSeededForkEvents(
    rawEvents: readonly unknown[],
    inheritedCount: number,
  ): Promise<{ readonly seed: readonly unknown[]; readonly inheritedEventCount: number }> {
    const clampedCount = Math.max(0, Math.min(rawEvents.length, inheritedCount))
    if (clampedCount === 0) {
      return { seed: [], inheritedEventCount: 0 }
    }
    const prefix = rawEvents.slice(0, clampedCount)
    const contiguousZeroBased = prefix.every((ev, idx) => asRecord(ev)?.seq === idx)
    if (contiguousZeroBased) {
      const modName = '@deepseek-ai/dsh-session'
      const candidates: string[] = [modName]
      if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) {
        try {
          const hostReq = createRequire(resolve(process.argv[1]))
          candidates.push(pathToFileURL(hostReq.resolve(modName)).href)
        } catch {
          // Ignore if argv[1] cannot resolve official peer packages.
        }
      }
      for (const specifier of candidates) {
        try {
          const mod = (await import(specifier)) as {
            buildForkSeed?: (events: readonly unknown[], boundary: number) => readonly unknown[]
          }
          if (typeof mod?.buildForkSeed === 'function') {
            return {
              seed: mod.buildForkSeed(rawEvents, clampedCount - 1),
              inheritedEventCount: clampedCount,
            }
          }
        } catch {
          // Optional official package when running in isolated adapter tests or external bundle.
        }
      }
    }
    return { seed: prefix, inheritedEventCount: prefix.length }
  }

  async forkSession(params: SessionForkParams): Promise<SessionRef> {
    if (!isSafeSessionId(params.sessionId)) {
      throw new RemoteProtocolError('INVALID_REQUEST', `invalid sessionId: ${params.sessionId}`)
    }
    const collection = this.getSessionEventCollection(params.sessionId)
    if (!collection) {
      const ref = await this.findSessionRef(params.sessionId)
      if (!ref) {
        throw new RemoteProtocolError('INVALID_REQUEST', `session not found: ${params.sessionId}`)
      }
    }
    const rawEvents = collection?.rawEvents ?? []
    const normalizedEvents = collection?.normalizedEvents ?? []
    let inheritedCount = rawEvents.length
    if (params.atSeq !== undefined) {
      let count = 0
      for (const ev of normalizedEvents) {
        if (ev.seq <= params.atSeq) count += 1
        else break
      }
      inheritedCount = Math.min(rawEvents.length, count)
    }
    const { seed, inheritedEventCount } = await this.buildSeededForkEvents(rawEvents, inheritedCount)
    const newSessionId = `session-${randomUUID()}`
    const cwd = collection?.cwd ?? this.cwd
    const parentTitle = collection?.title ?? (await this.findSessionRef(params.sessionId))?.title
    const resolvedTitle =
      params.title?.trim() && params.title.trim().length > 0
        ? params.title.trim()
        : parentTitle
          ? truncateByCodePoints(`Fork of ${parentTitle}`, 120)
          : undefined

    const handle = await this.ctx.agents.create({
      sessionId: newSessionId,
      meta: {
        cwd,
        parentSession: params.sessionId,
        isSeeded: true,
      },
      seed,
      inheritedEventCount,
      agentOptions: this.defaultAgentOptions(),
      setup: (_agentCtx, agent) => {
        if (agent) {
          this.attachAgentListeners(newSessionId, agent)
        }
      },
    })
    await handle.agent.whenIdle?.()
    this.ownedHandles.set(newSessionId, handle)
    this.attachAgentListeners(newSessionId, handle.agent, handle)

    if (resolvedTitle) {
      const titleSvc = readOptionalService<{
        rename?(session: unknown, title: string): { title?: string } | string
      }>(this.ctx, 'sessionTitle')
      let finalTitle = resolvedTitle
      if (titleSvc?.rename && handle.agent.session) {
        try {
          const renamed = titleSvc.rename(handle.agent.session, resolvedTitle)
          if (typeof renamed === 'string' && renamed.trim().length > 0) finalTitle = renamed.trim()
          else if (renamed && typeof renamed === 'object' && typeof renamed.title === 'string' && renamed.title.trim().length > 0) {
            finalTitle = renamed.title.trim()
          }
        } catch {
          // Keep resolvedTitle if rename hook rejects stub session.
        }
      }
      this.setBoundedSessionEntry(this.sessionTitleOverrides, newSessionId, finalTitle)
      this.emitNormalizedEvent(newSessionId, 'session/title', {
        sessionId: newSessionId,
        title: finalTitle,
        source: 'user',
      })
      return { id: newSessionId, title: finalTitle }
    }
    return { id: newSessionId }
  }

  async searchSessions(params: SessionSearchParams): Promise<SessionSearchResult> {
    const query = params.query.trim()
    if (query.length === 0) {
      return { query: params.query, hits: [], hasMore: false }
    }
    const sources: Array<{
      readonly sessionId: string
      readonly title?: string | undefined
      readonly updatedAt?: string | undefined
      readonly events: readonly NormalizedTranscriptEvent[]
    }> = []

    if (params.sessionId !== undefined) {
      const col = this.getSessionEventCollection(params.sessionId)
      if (!col) {
        throw new RemoteProtocolError('INVALID_REQUEST', `session not found: ${params.sessionId}`)
      }
      sources.push({
        sessionId: params.sessionId,
        title: col.title,
        events: col.normalizedEvents,
      })
    } else {
      const all = await this.listDshSessions()
      for (const ref of all.slice(0, 100)) {
        const col = this.getSessionEventCollection(ref.id)
        if (!col || col.normalizedEvents.length === 0) continue
        sources.push({
          sessionId: ref.id,
          title: ref.title ?? col.title,
          ...(ref.updatedAtMs !== undefined ? { updatedAt: new Date(ref.updatedAtMs).toISOString() } : {}),
          events: col.normalizedEvents,
        })
      }
    }

    const matched = searchSessionCollections({
      query,
      limit: params.limit,
      sessionId: params.sessionId,
      sources,
    })
    return {
      query,
      hits: matched.hits,
      hasMore: matched.hasMore,
    }
  }

  async listCommands(sessionId?: string): Promise<readonly RemoteCommandDescriptor[]> {
    const commandsSvc = readOptionalService<{
      list?(agent: OfficialAgentLike): readonly {
        readonly name?: unknown
        readonly description?: unknown
        readonly input?: {
          readonly hint?: unknown
          readonly attachments?: unknown
        }
        readonly inputHint?: unknown
        readonly acceptsAttachments?: unknown
      }[]
    }>(this.ctx, 'commands')
    if (!commandsSvc?.list) return []

    const agent =
      sessionId !== undefined
        ? await this.ensureLiveAgent(sessionId)
        : (this.bridgedSessions.values().next().value?.agent ?? this.ctx.agents.list()[0])
    if (!agent) return []

    const rawList = commandsSvc.list(agent)
    const out: RemoteCommandDescriptor[] = []
    for (const item of rawList) {
      if (typeof item?.name !== 'string' || item.name.length === 0) continue
      const inputHint =
        typeof item.input?.hint === 'string' && item.input.hint.length > 0
          ? item.input.hint
          : typeof item.inputHint === 'string' && item.inputHint.length > 0
            ? item.inputHint
            : undefined
      const acceptsAttachments =
        typeof item.input?.attachments === 'boolean'
          ? item.input.attachments
          : typeof item.acceptsAttachments === 'boolean'
            ? item.acceptsAttachments
            : undefined
      out.push({
        name: item.name,
        description: typeof item.description === 'string' ? item.description : '',
        ...(inputHint !== undefined ? { inputHint } : {}),
        ...(acceptsAttachments !== undefined ? { acceptsAttachments } : {}),
      })
    }
    return out
  }

  async executeCommand(
    sessionId: string,
    command: string,
  ): Promise<{
    readonly ok: boolean
    readonly commandId?: string | undefined
    readonly output?: string | undefined
    readonly error?: string | undefined
  }> {
    const trimmed = command.trim()
    if (!trimmed.startsWith('/') || trimmed.length < 2) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'command must start with "/"')
    }
    const agent = await this.ensureLiveAgent(sessionId)
    const commandsSvc = readOptionalService<{
      find?(agent: OfficialAgentLike, name: string): unknown
      execute?(
        agent: OfficialAgentLike,
        line: string,
        submittedAttachments?: readonly unknown[],
        signal?: AbortSignal,
      ): Promise<unknown>
    }>(this.ctx, 'commands')
    if (!commandsSvc?.execute) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'official commands service unavailable')
    }

    const commandId = trimmed.slice(1).split(/\s+/u, 1)[0] ?? trimmed.slice(1)
    if (commandsSvc.find && !commandsSvc.find(agent, commandId)) {
      return {
        ok: false,
        commandId,
        error: `unknown command: /${commandId}`,
      }
    }

    const rawResult = await commandsSvc.execute(
      agent,
      trimmed,
      [],
      new AbortController().signal,
    )
    if (rawResult === undefined) {
      return {
        ok: false,
        commandId,
        error: `unknown command: /${commandId}`,
      }
    }
    if (typeof rawResult === 'boolean') {
      return { ok: rawResult, commandId }
    }
    const rec = asRecord(rawResult)
    if (rec) {
      const nestedResult = asRecord(rec.result)
      const resolvedId = typeof rec.commandId === 'string' ? rec.commandId : commandId
      if (nestedResult && typeof nestedResult.kind === 'string') {
        const text = typeof nestedResult.text === 'string' ? nestedResult.text : undefined
        if (nestedResult.kind === 'error') {
          return {
            ok: false,
            commandId: resolvedId,
            error: text ?? `command /${commandId} failed`,
          }
        }
        return {
          ok: true,
          commandId: resolvedId,
          ...(text !== undefined ? { output: text } : {}),
        }
      }
      return {
        ok: typeof rec.ok === 'boolean' ? rec.ok : typeof rec.handled === 'boolean' ? rec.handled : true,
        commandId: resolvedId,
        ...(typeof rec.output === 'string' ? { output: rec.output } : {}),
        ...(typeof rec.error === 'string' ? { error: rec.error } : {}),
      }
    }
    return { ok: true, commandId }
  }

  async listSkills(sessionId?: string): Promise<readonly RemoteSkillSummary[]> {
    let cwd = this.cwd
    let scope: unknown
    if (sessionId !== undefined) {
      await this.assertSession(sessionId)
      const collection = this.getSessionEventCollection(sessionId)
      if (collection?.cwd) cwd = collection.cwd
      scope = collection?.agent?.ctx
    }
    const skillsSvc = readOptionalService<{
      list?(options?: {
        readonly scope?: unknown
        readonly cwd?: string
        readonly signal?: AbortSignal
      }): unknown
    }>(this.ctx, 'skills')
    if (!skillsSvc?.list) return []

    const rawValue = await Promise.resolve(
      skillsSvc.list({
        ...(scope !== undefined ? { scope } : {}),
        ...(cwd ? { cwd } : {}),
        signal: new AbortController().signal,
      }),
    )
    const raw = Array.isArray(rawValue)
      ? rawValue
      : Array.isArray(asRecord(rawValue)?.skills)
        ? (asRecord(rawValue)!.skills as unknown[])
        : []
    const out: RemoteSkillSummary[] = []
    for (const item of raw) {
      const rec = asRecord(item)
      if (!rec || typeof rec.name !== 'string' || rec.name.length === 0) continue
      out.push({
        name: rec.name,
        description: typeof rec.description === 'string' ? rec.description : '',
        ...(typeof rec.whenToUse === 'string' && rec.whenToUse.length > 0 ? { whenToUse: rec.whenToUse } : {}),
        ...(typeof rec.source === 'string' && rec.source.length > 0 ? { source: rec.source } : {}),
      })
    }
    return out
  }

  async openWorkspaceUpload(
    deviceId: string,
    params: WorkspaceUploadOpenParams,
  ): Promise<WorkspaceUploadOpenResult> {
    await this.assertSession(params.sessionId)
    const collection = this.getSessionEventCollection(params.sessionId)
    const workspaceRoot = collection?.cwd ?? this.cwd
    return this.workspaceUploads.open({
      deviceId,
      sessionId: params.sessionId,
      workspaceRoot,
      filename: params.filename,
      sizeBytes: params.sizeBytes,
      ...(params.chunkBytes !== undefined ? { chunkBytes: params.chunkBytes } : {}),
      ...(params.sha256 !== undefined ? { sha256: params.sha256 } : {}),
      ...(params.conflictPolicy !== undefined ? { conflictPolicy: params.conflictPolicy } : {}),
    })
  }

  async appendWorkspaceUploadChunk(
    deviceId: string,
    params: WorkspaceUploadChunkParams,
  ): Promise<WorkspaceUploadChunkResult> {
    return this.workspaceUploads.appendChunk({
      deviceId,
      uploadId: params.uploadId,
      offset: params.offset,
      dataBase64: params.dataBase64,
    })
  }

  async commitWorkspaceUpload(
    deviceId: string,
    params: WorkspaceUploadCommitParams,
  ): Promise<WorkspaceUploadCommitResult> {
    return this.workspaceUploads.commit({
      deviceId,
      uploadId: params.uploadId,
      ...(params.sha256 !== undefined ? { sha256: params.sha256 } : {}),
    })
  }

  async abortWorkspaceUpload(
    deviceId: string,
    params: WorkspaceUploadAbortParams,
  ): Promise<WorkspaceUploadAbortResult> {
    return this.workspaceUploads.abort({
      deviceId,
      uploadId: params.uploadId,
    })
  }

  private async buildPromptContentParts(
    prompt: string,
    attachments: readonly PromptImageAttachment[] | undefined,
  ): Promise<readonly Record<string, unknown>[]> {
    const parts: Record<string, unknown>[] = []
    if (prompt.length > 0) {
      parts.push({ type: 'text', text: prompt })
    }
    if (attachments && attachments.length > 0) {
      const attachmentsSvc = readOptionalService<{
        saveImage?(input: {
          readonly mediaType: string
          readonly bytes: Uint8Array
          readonly name?: string
        }): Promise<unknown>
      }>(this.ctx, 'attachments')

      for (const att of attachments) {
        const bytes = Buffer.from(att.dataBase64, 'base64')
        if (attachmentsSvc?.saveImage) {
          const ref = await attachmentsSvc.saveImage({
            mediaType: att.mediaType,
            bytes,
            ...(att.name !== undefined ? { name: att.name } : {}),
          })
          parts.push({ type: 'image', attachment: ref })
        } else {
          parts.push({
            type: 'image',
            mediaType: att.mediaType,
            dataBase64: att.dataBase64,
            ...(att.name !== undefined ? { name: att.name } : {}),
          })
        }
      }
    }
    return Object.freeze(parts)
  }

  async followup(
    sessionId: string,
    prompt: string,
    options?: FollowupOptions,
  ): Promise<{ sessionId: string; messageId: string }> {
    const agent = await this.ensureLiveAgent(sessionId)
    const messageId = randomUUID()
    const content = await this.buildPromptContentParts(prompt, options?.attachments)
    const message = Object.freeze({
      id: messageId,
      role: 'user',
      content,
      source: Object.freeze({ kind: 'user' }),
    })
    if (options?.mode === 'steer' && typeof agent.steer === 'function') {
      agent.steer(message)
    } else {
      agent.followup(message)
    }
    this.seenEvents.followups += 1
    return { sessionId, messageId }
  }

  async abortTurn(
    sessionId: string,
    options?: { readonly keepInbox?: boolean | undefined },
  ): Promise<{ sessionId: string; aborted: true }> {
    const agent = await this.ensureLiveAgent(sessionId)
    if (typeof agent.cancel !== 'function') {
      throw new RemoteProtocolError(
        'INVALID_REQUEST',
        'session agent does not support turn cancellation',
      )
    }
    agent.cancel(
      { kind: 'user' },
      options?.keepInbox ? { keepInbox: true } : undefined,
    )
    for (const [callId, pending] of this.pendingApprovals.entries()) {
      if (pending.sessionId === sessionId) {
        this.pendingApprovals.delete(callId)
        pending.cleanup()
        pending.resolve('cancelled')
        this.emitNormalizedEvent(sessionId, 'approval.resolved', {
          callId,
          decision: 'cancelled',
        })
      }
    }
    for (const [questionId, pending] of this.pendingQuestions.entries()) {
      if (pending.sessionId === sessionId) {
        this.pendingQuestions.delete(questionId)
        pending.cleanup()
        pending.reject(new Error('question request aborted (ASK_ABORTED)'))
        this.emitNormalizedEvent(sessionId, 'question.resolved', {
          questionId,
          cancelled: true,
        })
      }
    }
    return { sessionId, aborted: true }
  }

  async listModels(sessionId?: string): Promise<ModelCatalogResult> {
    let current: ModelSelectionParams | undefined
    if (sessionId) {
      const agent = await this.ensureLiveAgent(sessionId)
      const selected = agent.model?.current?.()
      if (selected?.provider && selected?.model) {
        current = {
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
        }
      } else if (agent.options?.provider && agent.options?.model) {
        current = {
          provider: agent.options.provider,
          model: agent.options.model,
        }
      }
    }
    if (!current) {
      const fallback = this.ctx.agentDefaultModel?.currentSelection()
      if (fallback?.provider && fallback?.model) {
        current = { provider: fallback.provider, model: fallback.model }
      }
    }

    const llmSvc = readOptionalService<{
      listProviders?(): ReadonlyArray<{ readonly id: string; readonly name?: string }>
      listModels?(
        provider: string,
      ): Promise<
        ReadonlyArray<{
          readonly id: string
          readonly name?: string
          readonly description?: string
          readonly inputModalities?: readonly string[]
        }>
      >
      resolveModel?(
        provider: string,
        model: string,
      ): Promise<{
        readonly inputModalities?: readonly string[]
        readonly context?: { readonly contextWindow?: number }
        readonly reasoning?: {
          readonly efforts?: ReadonlyArray<{
            readonly id: string
            readonly name?: string
            readonly description?: string
          }>
          readonly defaultEffort?: string
        }
      }>
    }>(this.ctx, 'llm')
    const models: ModelOptionRef[] = []
    if (llmSvc?.listProviders && llmSvc?.listModels) {
      for (const provider of llmSvc.listProviders()) {
        try {
          const items = await llmSvc.listModels(provider.id)
          const resolvedList = llmSvc.resolveModel
            ? await Promise.allSettled(
                items.map((m) => llmSvc.resolveModel!(provider.id, m.id)),
              )
            : []
          for (let idx = 0; idx < items.length; idx += 1) {
            const m = items[idx]!
            const settled = resolvedList[idx]
            const resolved =
              settled?.status === 'fulfilled' ? settled.value : undefined
            const modalities = resolved?.inputModalities ?? m.inputModalities
            const supportsImageInput = Array.isArray(modalities)
              ? modalities.includes('image')
              : undefined
            const rawEfforts = resolved?.reasoning?.efforts
            const reasoningEfforts: ReasoningEffortOption[] | undefined =
              Array.isArray(rawEfforts) && rawEfforts.length > 0
                ? rawEfforts
                    .filter((e) => typeof e?.id === 'string' && e.id.length > 0)
                    .map((e) => ({
                      id: e.id,
                      name: typeof e.name === 'string' && e.name.length > 0 ? e.name : e.id,
                      ...(typeof e.description === 'string' && e.description.length > 0
                        ? { description: e.description }
                        : {}),
                    }))
                : undefined
            const defaultReasoningEffort =
              typeof resolved?.reasoning?.defaultEffort === 'string' &&
              resolved.reasoning.defaultEffort.length > 0
                ? resolved.reasoning.defaultEffort
                : undefined
            const contextWindow =
              typeof resolved?.context?.contextWindow === 'number' &&
              resolved.context.contextWindow > 0
                ? resolved.context.contextWindow
                : undefined
            models.push({
              provider: provider.id,
              ...(provider.name ? { providerName: provider.name } : {}),
              model: m.id,
              name: m.name ?? m.id,
              ...(m.description ? { description: m.description } : {}),
              ...(supportsImageInput !== undefined ? { supportsImageInput } : {}),
              ...(reasoningEfforts !== undefined && reasoningEfforts.length > 0
                ? { reasoningEfforts }
                : {}),
              ...(defaultReasoningEffort !== undefined ? { defaultReasoningEffort } : {}),
              ...(contextWindow !== undefined ? { contextWindow } : {}),
            })
          }
        } catch {
          // Isolate unhealthy providers from blocking valid ones.
        }
      }
    } else if (current) {
      models.push({
        provider: current.provider,
        model: current.model,
        name: current.model,
      })
    }
    return {
      ...(current !== undefined ? { current } : {}),
      models,
    }
  }

  async selectModel(
    sessionId: string,
    selection: ModelSelectionParams,
  ): Promise<{ readonly sessionId: string; readonly selection: ModelSelectionParams }> {
    const agent = await this.ensureLiveAgent(sessionId)
    if (!agent.model?.select) {
      throw new RemoteProtocolError(
        'INVALID_REQUEST',
        'session agent does not support model selection',
      )
    }
    const llmSvc = readOptionalService<{
      resolveCallConfig?(config: ModelSelectionParams): Promise<unknown>
    }>(this.ctx, 'llm')
    if (llmSvc?.resolveCallConfig) {
      try {
        await llmSvc.resolveCallConfig(selection)
      } catch (err) {
        throw new RemoteProtocolError(
          'INVALID_REQUEST',
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    agent.model.select(selection)
    this.emitNormalizedEvent(sessionId, 'session.model', {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
    })
    return { sessionId, selection }
  }

  async respondApproval(
    callId: string,
    decision: 'approved' | 'rejected',
  ): Promise<{ callId: string; decision: 'approved' | 'rejected' }> {
    const pending = this.pendingApprovals.get(callId)
    if (!pending) {
      throw new RemoteProtocolError('INVALID_REQUEST', `no pending approval for callId '${callId}'`)
    }
    this.pendingApprovals.delete(callId)
    pending.cleanup()
    this.seenEvents.approvals += 1
    pending.resolve(decision === 'approved' ? 'allowed-once' : 'rejected')
    this.emitNormalizedEvent(pending.sessionId, 'approval.resolved', { callId, decision })
    return { callId, decision }
  }

  async respondQuestion(
    questionId: string,
    answer: unknown,
  ): Promise<{ questionId: string; accepted: true }> {
    const pending = this.pendingQuestions.get(questionId)
    if (!pending) {
      throw new RemoteProtocolError('INVALID_REQUEST', `no pending question for '${questionId}'`)
    }
    const obj = asRecord(answer)
    const isCancel =
      obj !== undefined &&
      !Array.isArray(obj.answers) &&
      (obj.cancelled === true || obj.rejected === true || obj.declined === true)
    if (isCancel) {
      this.pendingQuestions.delete(questionId)
      pending.cleanup()
      this.seenEvents.questions += 1
      pending.reject(
        Object.assign(new Error('The user declined to answer this question. (ASK_CANCELLED)'), {
          code: 'ASK_CANCELLED',
        }),
      )
      this.emitNormalizedEvent(pending.sessionId, 'question.resolved', {
        questionId,
        cancelled: true,
      })
      return { questionId, accepted: true }
    }
    const normalized = normalizeQuestionAnswer(pending.questions, answer)
    this.pendingQuestions.delete(questionId)
    pending.cleanup()
    this.seenEvents.questions += 1
    pending.resolve(normalized)
    this.emitNormalizedEvent(pending.sessionId, 'question.resolved', {
      questionId,
      answers: normalized.answers,
    })
    return { questionId, accepted: true }
  }

  async issuePairingDescriptor(options?: {
    readonly ttlMs?: number | undefined
    readonly allowedCapabilities?: readonly Capability[] | undefined
    readonly endpointUrl?: string | undefined
  }): Promise<PairingIssueResult> {
    const identity = await this.stores.hostIdentityStore.loadOrCreate()
    const endpointUrl =
      options?.endpointUrl ?? this.runtime.carrier.getEndpointUrl()
    if (!endpointUrl) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'LAN carrier endpoint is not running')
    }
    const token = this.tokenRegistry.createToken({
      trustDomainId: identity.identity.trustDomainId,
      hostGeneration: identity.identity.generation,
      ttlMs: options?.ttlMs ?? this.options.pairingTtlMs ?? MAX_PAIRING_TTL_MS,
      allowedCapabilities: options?.allowedCapabilities ?? DEFAULT_GRANTED_CAPABILITIES,
    })

    const relayUrl = this.options.relay?.relayUrl ?? this.options.relayUrlHint
    const relayRoomId = this.runtime.relay?.getRoomId() ?? this.options.relayRoomIdHint
    const signalingUrl = this.options.webrtc?.signalingUrl ?? this.options.signalingUrlHint
    const signalingRoomId = this.options.webrtc?.roomId ?? this.options.signalingRoomIdHint
    const stunUrls = this.options.webrtc?.ice?.stunUrls ?? this.options.stunUrlsHint

    const descriptor = createPairingBootstrapDescriptor({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      hostPublicKey: identity.identity.publicKey,
      bootstrapToken: token.token,
      endpointUrl,
      expiresAt: token.expiresAt,
      ...(signalingUrl !== undefined ? { signalingUrl } : {}),
      ...(signalingRoomId !== undefined ? { signalingRoomId } : {}),
      ...(stunUrls !== undefined && stunUrls.length > 0 ? { stunUrls } : {}),
      ...(relayUrl !== undefined ? { relayUrl } : {}),
      ...(relayRoomId !== undefined ? { relayRoomId } : {}),
    })

    return {
      descriptor,
      pairingJson: JSON.stringify(descriptor),
      deepLink: encodePairingDeepLink(descriptor),
      tokenHash: token.tokenHash,
      expiresAt: token.expiresAt,
    }
  }

  async listTrustedDevices(): Promise<readonly DeviceRecord[]> {
    return this.stores.trustStore.list()
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    this.workspaceUploads.revokeDevice(deviceId)
    this.router.revokeDeviceUploads(deviceId)
    return this.stores.trustStore.revoke(deviceId)
  }

  /**
   * Drops the in-memory replay buffer for `sessionId` and pushes a `stream.reset`
   * notification to all connected remote clients across enabled carriers.
   */
  resetSessionStream(sessionId: string, reason = 'window-unavailable'): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'sessionId is required')
    }
    this.runtime.forgetSession(sessionId, reason)
  }

  async getStatus(): Promise<{
    readonly started: boolean
    readonly configDir: string
    readonly dshHome: string
    readonly hostFingerprint: string | undefined
    readonly lanEndpointUrl: string | undefined
    readonly relayRoomId: string | undefined
    readonly activeSessions: readonly string[]
    readonly trustedDevices: number
    readonly activeConnections: number
    readonly pendingApprovals: number
    readonly pendingQuestions: number
    readonly pendingPairingCandidates: number
    readonly engines: readonly EngineDescriptor[]
    readonly metrics: {
      readonly ingested: number
      readonly followups: number
      readonly approvals: number
      readonly questions: number
    }
  }> {
    let hostFingerprint: string | undefined
    try {
      hostFingerprint = (await this.stores.hostIdentityStore.getPublicIdentity()).fingerprint
    } catch {
      hostFingerprint = undefined
    }
    const [devices, engines] = await Promise.all([
      this.stores.trustStore.list(),
      this.listEngines(),
    ])
    return {
      started: this.started && !this.stopped,
      configDir: this.stores.configDir,
      dshHome: this.dshHome,
      hostFingerprint,
      lanEndpointUrl: this.runtime.carrier.getEndpointUrl(),
      relayRoomId: this.runtime.relay?.getRoomId(),
      activeSessions: [...this.bridgedSessions.keys()],
      trustedDevices: devices.filter((d) => d.revokedAt === undefined).length,
      activeConnections: this.runtime.carrier.getActiveConnectionCount(),
      pendingApprovals: this.pendingApprovals.size,
      pendingQuestions: this.pendingQuestions.size,
      pendingPairingCandidates: this.pairingCoordinator.listPendingCandidates().length,
      engines,
      metrics: { ...this.seenEvents },
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true

    for (const [callId, pending] of this.pendingApprovals.entries()) {
      this.pendingApprovals.delete(callId)
      pending.cleanup()
      pending.resolve('cancelled')
    }
    for (const [qId, pending] of this.pendingQuestions.entries()) {
      this.pendingQuestions.delete(qId)
      pending.cleanup()
      pending.reject(new Error('question cancelled: host shutting down (ASK_ABORTED)'))
    }
    for (const state of this.bridgedSessions.values()) {
      for (const unsub of state.unsubscribes) unsub()
    }
    this.bridgedSessions.clear()
    this.bridgedStatusBySession.clear()
    this.sessionTitleOverrides.clear()
    this.transcriptCache.clear()
    this.transcriptCacheEvents = 0
    this.liveLogCache.clear()
    this.workspaceUploads.disposeAll()
    for (const unsub of this.rootUnsubscribes) {
      unsub()
    }
    this.rootUnsubscribes.length = 0

    const sessionsSvc =
      (this.ctx.sessions as { flush?(session: unknown): Promise<void> } | undefined) ??
      (this.ctx.get?.('sessions') as { flush?(session: unknown): Promise<void> } | undefined)
    for (const [sessionId, handle] of this.ownedHandles.entries()) {
      await handle.agent.whenIdle?.().catch(() => {})
      if (handle.agent.session) {
        if (typeof sessionsSvc?.flush === 'function') {
          await sessionsSvc.flush(handle.agent.session).catch(() => {})
        } else if (typeof this.ctx.parallel === 'function') {
          await this.ctx.parallel('session/flush', handle.agent.session).catch(() => {})
        }
      }
      await handle.dispose().catch(() => {})
      this.ownedHandles.delete(sessionId)
    }
    this.ownedHandles.clear()

    await this.router.stop()
    await this.runtime.stop()
  }
}

function readOptionalService<T>(
  ctx: OfficialCordisContextLike,
  key: string,
): T | undefined {
  if (typeof ctx.get === 'function') {
    const resolved = ctx.get(key) as T | undefined
    if (resolved !== undefined) return resolved
  }
  return (ctx as unknown as Record<string, unknown>)[key] as T | undefined
}

function normalizeQuestionAnswer(
  questions: readonly Record<string, unknown>[],
  answer: unknown,
): { answers: Array<{ id: string; selected: string[]; custom?: string }> } {
  const obj = asRecord(answer)
  if (obj && Array.isArray(obj.answers)) {
    const items: Array<{ id: string; selected: string[]; custom?: string }> = []
    for (const rawItem of obj.answers) {
      const rec = asRecord(rawItem)
      if (!rec || typeof rec.id !== 'string') continue
      const selected = Array.isArray(rec.selected)
        ? rec.selected.filter((x): x is string => typeof x === 'string')
        : []
      items.push({
        id: rec.id,
        selected,
        ...(typeof rec.custom === 'string' ? { custom: rec.custom } : {}),
      })
    }
    if (items.length > 0) return { answers: items }
  }

  const firstQuestion = questions[0]
  const firstId =
    firstQuestion && typeof firstQuestion.id === 'string' && firstQuestion.id.length > 0
      ? firstQuestion.id
      : 'q1'

  if (typeof answer === 'string') {
    const options = Array.isArray(firstQuestion?.options) ? firstQuestion.options : []
    const matchedOption = options.some(
      (opt) => asRecord(opt)?.label === answer,
    )
    return {
      answers: [
        matchedOption
          ? { id: firstId, selected: [answer] }
          : { id: firstId, selected: [], custom: answer },
      ],
    }
  }

  if (obj) {
    return {
      answers: questions.map((q, idx) => {
        const qid = typeof q.id === 'string' && q.id.length > 0 ? q.id : `q${idx + 1}`
        const val = obj[qid]
        if (typeof val === 'string') {
          const options = Array.isArray(q.options) ? q.options : []
          const matched = options.some((opt) => asRecord(opt)?.label === val)
          return matched
            ? { id: qid, selected: [val] }
            : { id: qid, selected: [], custom: val }
        }
        return { id: qid, selected: [] }
      }),
    }
  }

  throw new RemoteProtocolError('INVALID_REQUEST', 'question answer could not be normalized')
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.byteLength
    if (total > 64 * 1024) {
      throw new RemoteProtocolError('INVALID_REQUEST', 'control request body too large')
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true
  const trimmed = hostHeader.trim().toLowerCase()
  return (
    /^127\.0\.0\.1(?::\d+)?$/u.test(trimmed) ||
    /^localhost(?::\d+)?$/u.test(trimmed) ||
    /^\[::1\](?::\d+)?$/u.test(trimmed)
  )
}

function hasValidBearerToken(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const actual = header.slice('Bearer '.length)
  const expectedBuf = Buffer.from(expectedToken, 'utf8')
  const actualBuf = Buffer.from(actual, 'utf8')
  if (expectedBuf.byteLength !== actualBuf.byteLength) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

export async function createBridgeControlServer(
  bridge: RemoteControlBridgeLike,
  options?: {
    readonly port?: number | undefined
    readonly controlToken?: string | undefined
    readonly onShutdown?: (() => Promise<void> | void) | undefined
  },
): Promise<BridgeControlServerHandle> {
  const controlToken = options?.controlToken ?? randomBytes(24).toString('hex')

  const server: Server = createServer(async (req, res) => {
    try {
      if (!isLoopbackHostHeader(req.headers.host)) {
        sendJson(res, 403, { error: 'non-loopback Host header rejected' })
        return
      }
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && reqUrl.pathname === '/status') {
        sendJson(res, 200, await bridge.getStatus())
        return
      }
      if (!hasValidBearerToken(req, controlToken)) {
        sendJson(res, 401, { error: 'unauthorized control request' })
        return
      }
      if (req.method === 'GET' && reqUrl.pathname === '/engines') {
        const engines = bridge.listEngines ? await bridge.listEngines() : []
        sendJson(res, 200, { engines })
        return
      }
      if (req.method === 'GET' && reqUrl.pathname === '/sessions') {
        sendJson(res, 200, { sessions: await bridge.listSessions() })
        return
      }
      if (req.method === 'POST' && reqUrl.pathname === '/sessions') {
        const body = await readJsonBody(req)
        const engine = typeof body.engine === 'string' ? (body.engine as AgentEngineId) : undefined
        let model: ModelSelectionParams | undefined
        if (typeof body.model === 'string' && body.model.trim().length > 0) {
          model = { provider: engine ?? 'default', model: body.model.trim() }
        } else if (body.model && typeof body.model === 'object') {
          const rec = body.model as Record<string, unknown>
          if (typeof rec.model === 'string' && rec.model.trim().length > 0) {
            model = {
              provider: typeof rec.provider === 'string' ? rec.provider : (engine ?? 'default'),
              model: rec.model.trim(),
              ...(typeof rec.reasoningEffort === 'string' ? { reasoningEffort: rec.reasoningEffort } : {}),
            }
          }
        }
        const session = await bridge.createSession({
          ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
          ...(engine !== undefined ? { engine } : {}),
          ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(model !== undefined ? { model } : {}),
        })
        sendJson(res, 200, { session })
        return
      }
      if (req.method === 'GET' && reqUrl.pathname === '/git/status') {
        if (!bridge.getWorkspaceGitStatus) {
          sendJson(res, 404, { error: 'git review not supported' })
          return
        }
        const sessionId = reqUrl.searchParams.get('sessionId')?.trim()
        if (!sessionId) {
          sendJson(res, 400, { error: 'sessionId query parameter is required' })
          return
        }
        const result = await bridge.getWorkspaceGitStatus({ sessionId })
        sendJson(res, 200, result)
        return
      }
      if (req.method === 'GET' && reqUrl.pathname === '/git/diff') {
        if (!bridge.getWorkspaceGitDiff) {
          sendJson(res, 404, { error: 'git review not supported' })
          return
        }
        const sessionId = reqUrl.searchParams.get('sessionId')?.trim()
        if (!sessionId) {
          sendJson(res, 400, { error: 'sessionId query parameter is required' })
          return
        }
        const filePath = reqUrl.searchParams.get('path') ?? undefined
        const stagedParam = reqUrl.searchParams.get('staged')
        const staged = stagedParam === '1' || stagedParam === 'true' ? true : undefined
        const maxBytesRaw = reqUrl.searchParams.get('maxBytes')
        const maxBytes = maxBytesRaw !== null && maxBytesRaw.trim() !== '' ? Number(maxBytesRaw) : undefined
        const result = await bridge.getWorkspaceGitDiff({
          sessionId,
          ...(filePath !== undefined && filePath.length > 0 ? { path: filePath } : {}),
          ...(staged !== undefined ? { staged } : {}),
          ...(maxBytes !== undefined && Number.isFinite(maxBytes) ? { maxBytes } : {}),
        })
        sendJson(res, 200, result)
        return
      }
      if (req.method === 'POST' && reqUrl.pathname === '/sessions/reset') {
        const body = await readJsonBody(req)
        if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
          sendJson(res, 400, { error: 'sessionId is required' })
          return
        }
        const reason =
          typeof body.reason === 'string' && body.reason.length > 0
            ? body.reason
            : 'window-unavailable'
        bridge.resetSessionStream(body.sessionId, reason)
        sendJson(res, 200, { ok: true, sessionId: body.sessionId, reason })
        return
      }
      if (req.method === 'POST' && reqUrl.pathname === '/pairing-token') {
        const body = await readJsonBody(req)
        const caps = Array.isArray(body.allowedCapabilities)
          ? (body.allowedCapabilities as Capability[])
          : undefined
        const issued = await bridge.issuePairingDescriptor({
          ...(typeof body.ttlMs === 'number' ? { ttlMs: body.ttlMs } : {}),
          ...(caps ? { allowedCapabilities: caps } : {}),
        })
        sendJson(res, 200, issued)
        return
      }
      if (req.method === 'GET' && reqUrl.pathname === '/pairing/pending') {
        sendJson(res, 200, {
          pending: bridge.pairingCoordinator.listPendingCandidates().map((c) => ({
            candidateId: c.candidateId,
            deviceId: c.deviceId,
            displayName: c.displayName,
            maxAllowedCapabilities: c.maxAllowedCapabilities,
            expiresAt: c.expiresAt,
            state: c.state,
          })),
        })
        return
      }
      if (req.method === 'POST' && reqUrl.pathname === '/pairing/confirm') {
        const body = await readJsonBody(req)
        if (typeof body.candidateId !== 'string' || body.candidateId.length === 0) {
          sendJson(res, 400, { error: 'candidateId is required' })
          return
        }
        const grantedCapabilities = Array.isArray(body.grantedCapabilities)
          ? (body.grantedCapabilities as Capability[])
          : DEFAULT_GRANTED_CAPABILITIES
        const confirmed = await bridge.pairingCoordinator.confirmPairing({
          candidateId: body.candidateId,
          grantedCapabilities,
        })
        sendJson(res, 200, {
          ok: true,
          deviceId: confirmed.device.deviceId,
          displayName: confirmed.device.displayName,
        })
        return
      }
      if (req.method === 'GET' && reqUrl.pathname === '/devices') {
        const devices = await bridge.listTrustedDevices()
        sendJson(res, 200, {
          devices: devices.map((d) => ({
            deviceId: d.deviceId,
            displayName: d.displayName,
            capabilities: [...d.grantedCapabilities],
            pairedAt: d.pairedAt,
            lastSeenAt: d.lastSeenAt,
            ...(d.revokedAt !== undefined ? { revokedAt: d.revokedAt } : {}),
          })),
        })
        return
      }
      if (req.method === 'POST' && reqUrl.pathname === '/devices/revoke') {
        const body = await readJsonBody(req)
        if (typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
          sendJson(res, 400, { error: 'deviceId is required' })
          return
        }
        const revoked = await bridge.revokeDevice(body.deviceId)
        sendJson(res, 200, { ok: true, revoked, deviceId: body.deviceId })
        return
      }
      if (req.method === 'POST' && reqUrl.pathname === '/shutdown') {
        sendJson(res, 200, { ok: true })
        await bridge.stop()
        server.closeAllConnections?.()
        await new Promise<void>((r) => server.close(() => r()))
        await options?.onShutdown?.()
        return
      }
      sendJson(res, 404, { error: 'not found' })
    } catch (err) {
      const status = err instanceof RemoteCryptoError ? 403 : 400
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) })
    }
  })

  server.headersTimeout = 10_000
  server.requestTimeout = 15_000

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options?.port ?? 0, '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })

  const addr = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${addr.port}`,
    controlToken,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}
