import { timingSafeEqual, randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { DeviceRecord } from './crypto/device-trust.js'
import { RemoteCryptoError } from './crypto/errors.js'
import { FileDeviceTrustStore } from './crypto/file-device-trust.js'
import { FileHostIdentityStore } from './crypto/file-host-identity.js'
import { PairingCoordinator, type PairingConfirmationParams, type PairingResult } from './crypto/pairing-coordinator.js'
import {
  MAX_PAIRING_TTL_MS,
  PairingTokenRegistry,
  type PairingCandidateView,
} from './crypto/pairing-token.js'
import type { NoiseResponderSession } from './crypto/noise.js'
import { RemoteProtocolError } from './errors.js'
import { RemoteHostRuntime, type RemoteHostRuntimeOptions } from './host-runtime.js'
import {
  REMOTE_PROTOCOL_VERSION,
  type Capability,
  type OfficialRemoteSeams,
  type SessionRef,
} from './protocol.js'
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
  readonly session?: {
    readonly id?: string
    readonly log?: readonly unknown[]
  }
  readonly ctx: OfficialAgentContextLike
  followup(message: Record<string, unknown>): void
  cancel?(cause: string): void
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
  on?(event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }): () => void
  parallel?(event: string, ...args: unknown[]): Promise<unknown>
  get?(name: string): unknown
}

export interface PersistentRemoteStores {
  readonly configDir: string
  readonly hostIdentityPath: string
  readonly trustedDevicesPath: string
  readonly hostIdentityStore: FileHostIdentityStore
  readonly trustStore: FileDeviceTrustStore
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

export interface OfficialHostCordisBridgeOptions {
  readonly ctx: OfficialCordisContextLike
  readonly configDir?: string | undefined
  readonly dshHome?: string | undefined
  readonly sessionRoot?: string | undefined
  readonly cwd?: string | undefined
  readonly listPersistedSessions?: (() => Promise<readonly SessionRef[]> | readonly SessionRef[]) | undefined
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

export function defaultRemoteDshHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const fromEnv = env.DSH_HOME?.trim()
  if (fromEnv && fromEnv.length > 0) {
    return resolve(fromEnv)
  }
  return resolve(home, '.dsh')
}

export function defaultRemoteConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.DSH_REMOTE_CONFIG_DIR?.trim()
  if (override && override.length > 0) {
    return resolve(override)
  }
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
    return resolve(appData, 'dsh-community', 'remote')
  }
  const xdgConfig = env.XDG_CONFIG_HOME?.trim()
  const base = xdgConfig && xdgConfig.length > 0 ? resolve(xdgConfig) : resolve(home, '.config')
  return resolve(base, 'dsh-community', 'remote')
}

function canonicalizePathWithExistingAncestor(targetPath: string): string {
  const resolved = resolve(targetPath)
  try {
    return realpathSync(resolved)
  } catch {
    const parent = dirname(resolved)
    if (parent !== resolved) {
      try {
        return join(realpathSync(parent), resolved.slice(parent.length + 1))
      } catch {
        return resolved
      }
    }
    return resolved
  }
}

/**
 * Enforces `docs/remote-host-client.md` storage isolation: Community OS Remote state
 * (`host-identity.json`, `trusted-devices.json`) must never reside inside official `DSH_HOME`.
 */
export function assertOutsideOfficialDshHome(
  configDir: string,
  dshHome: string = defaultRemoteDshHome(),
): string {
  if (!isAbsolute(configDir)) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      `remote configDir must be an absolute path: ${configDir}`,
    )
  }
  const canonicalConfig = canonicalizePathWithExistingAncestor(configDir)
  const canonicalDshHome = canonicalizePathWithExistingAncestor(dshHome)
  if (
    canonicalConfig === canonicalDshHome ||
    canonicalConfig.startsWith(canonicalDshHome + sep)
  ) {
    throw new RemoteProtocolError(
      'INVALID_REQUEST',
      `community remote configDir '${canonicalConfig}' must remain strictly outside official DSH_HOME '${canonicalDshHome}'`,
    )
  }
  return canonicalConfig
}

export function openPersistentRemoteStores(options: {
  readonly configDir?: string | undefined
  readonly dshHome?: string | undefined
  readonly clock?: (() => number) | undefined
} = {}): PersistentRemoteStores {
  const dshHome = options.dshHome ?? defaultRemoteDshHome()
  const rawConfigDir = options.configDir ?? defaultRemoteConfigDir()
  const configDir = assertOutsideOfficialDshHome(rawConfigDir, dshHome)
  mkdirSync(configDir, { recursive: true, mode: 0o700 })

  const hostIdentityPath = join(configDir, 'host-identity.json')
  const trustedDevicesPath = join(configDir, 'trusted-devices.json')

  const storeClock = options.clock ? { clock: options.clock } : undefined
  const hostIdentityStore = new FileHostIdentityStore(hostIdentityPath, storeClock)
  FileDeviceTrustStore.recover(trustedDevicesPath)
  const trustStore = new FileDeviceTrustStore(trustedDevicesPath, storeClock)

  return {
    configDir,
    hostIdentityPath,
    trustedDevicesPath,
    hostIdentityStore,
    trustStore,
  }
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
  if (filePath.endsWith('.zstd')) return undefined
  try {
    const raw = readFileSync(filePath, 'utf8')
    const nl = raw.indexOf('\n')
    const firstLine = (nl >= 0 ? raw.slice(0, nl) : raw).trim()
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
  }
}

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
  readonly runtime: RemoteHostRuntime

  private readonly ctx: OfficialCordisContextLike
  private readonly dshHome: string
  private readonly sessionRoot: string
  private readonly cwd: string
  private readonly options: OfficialHostCordisBridgeOptions
  private readonly bridgedSessions = new Map<string, BridgedSessionState>()
  private readonly ownedHandles = new Map<string, OfficialAgentHandleLike>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
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

    const seams: OfficialRemoteSeams = {
      listSessions: () => this.listSessions(),
      assertSession: (sessionId) => this.assertSession(sessionId),
      followup: (sessionId, prompt) => this.followup(sessionId, prompt),
      respondApproval: (callId, decision) => this.respondApproval(callId, decision),
      respondQuestion: (questionId, answer) => this.respondQuestion(questionId, answer),
    }

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
  }

  async start(): Promise<void> {
    if (this.started) return
    await this.stores.hostIdentityStore.loadOrCreate()
    await this.awaitCordisLoader()
    this.installRootListeners()
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

  private emitNormalizedEvent(sessionId: string, type: string, data?: unknown): void {
    const entry = this.bridgedSessions.get(sessionId)
    if (!entry) return
    entry.nextNormalizedSeq += 1
    const seq = entry.nextNormalizedSeq
    const item = data !== undefined ? { seq, type, data } : { seq, type }
    this.runtime.ingestSessionEventBatch(sessionId, { log: [item] })
    this.seenEvents.ingested += 1
  }

  private ingestOfficialEvent(sessionId: string, raw: unknown): void {
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

    this.emitNormalizedEvent(sessionId, event.type, payloadData)
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
        this.ingestOfficialEvent(sessionId, item)
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

    return state
  }

  async createSession(options?: {
    readonly sessionId?: string | undefined
    readonly cwd?: string | undefined
  }): Promise<SessionRef> {
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
    return { id: sessionId, title: cwd }
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
    const all = await this.listSessions()
    return all.find((s) => s.id === sessionId)
  }

  async listSessions(): Promise<readonly SessionRef[]> {
    const merged = new Map<string, SessionRef>()
    for (const agent of this.ctx.agents.list()) {
      merged.set(agent.id, { id: agent.id })
    }
    for (const state of this.bridgedSessions.values()) {
      if (!merged.has(state.id)) {
        merged.set(state.id, { id: state.id })
      }
    }
    for (const ref of await this.listPersistedRefs()) {
      if (!merged.has(ref.id)) {
        merged.set(ref.id, ref)
      }
    }
    return Object.freeze([...merged.values()])
  }

  async assertSession(sessionId: string): Promise<void> {
    await this.ensureLiveAgent(sessionId)
  }

  async followup(sessionId: string, prompt: string): Promise<{ sessionId: string; messageId: string }> {
    const agent = await this.ensureLiveAgent(sessionId)
    const messageId = randomUUID()
    const message = Object.freeze({
      id: messageId,
      role: 'user',
      content: Object.freeze([{ type: 'text', text: prompt }]),
      source: Object.freeze({ kind: 'user' }),
    })
    agent.followup(message)
    this.seenEvents.followups += 1
    return { sessionId, messageId }
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
    return this.stores.trustStore.revoke(deviceId)
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
    const devices = await this.stores.trustStore.list()
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

    await this.runtime.stop()
  }
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
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
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
  bridge: OfficialHostCordisBridge,
  options?: {
    readonly port?: number | undefined
    readonly controlToken?: string | undefined
    readonly onShutdown?: (() => Promise<void> | void) | undefined
  },
): Promise<BridgeControlServerHandle> {
  const controlToken = options?.controlToken ?? randomBytes(24).toString('hex')

  const server: Server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && reqUrl.pathname === '/status') {
        sendJson(res, 200, await bridge.getStatus())
        return
      }
      if (!hasValidBearerToken(req, controlToken)) {
        sendJson(res, 401, { error: 'unauthorized control request' })
        return
      }
      if (req.method === 'GET' && reqUrl.pathname === '/sessions') {
        sendJson(res, 200, { sessions: await bridge.listSessions() })
        return
      }
      if (req.method === 'POST' && reqUrl.pathname === '/sessions') {
        const body = await readJsonBody(req)
        const session = await bridge.createSession({
          ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
          ...(typeof body.cwd === 'string' ? { cwd: body.cwd } : {}),
        })
        sendJson(res, 200, { session })
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
