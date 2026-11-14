import { hexToBytes, randomUuid, utf8Decode, utf8Encode } from '../crypto/bytes.ts'
import { NoiseIkInitiator } from '../crypto/noise-ik.ts'
import { RemoteWebKeyStore } from './keystore.ts'
import { descriptorToTrustedProfile, sanitizeDiagnosticMessage } from './pairing.ts'
import {
  createBlindRelayWebSocketTransport,
  createBrowserWebRtcTransport,
  createLanWebSocketTransport,
  type FramedTransport,
  type WebSocketFactory,
} from './transports.ts'
import {
  MAX_NOISE_PLAINTEXT_BYTES,
  type ConnectionStatus,
  type CreateSessionParams,
  type EngineDescriptor,
  type ModelCatalogResult,
  type ModelSelectionParams,
  type OfficialSessionEvent,
  type PairingBootstrapDescriptor,
  type PromptImageAttachment,
  type RemoteCommandDescriptor,
  type RemoteSkillSummary,
  type SessionAttachResult,
  type SessionHistoryResult,
  type SessionRef,
  type SessionSearchResult,
  type TransportKind,
  type TrustedHostProfile,
  type WorkspaceFilesResult,
  type WorkspaceGitDiffResult,
  type WorkspaceGitStatusResult,
} from './types.ts'

export interface RemoteClientConnectOptions {
  readonly displayName?: string | undefined
  readonly bootstrapToken?: string | undefined
  readonly allowEpochReset?: boolean | undefined
  readonly autoPairPollIntervalMs?: number | undefined
  readonly handshakeTimeoutMs?: number | undefined
  readonly requestTimeoutMs?: number | undefined
  readonly webSocketFactory?: WebSocketFactory | undefined
}

export interface RemoteClientStatusEvent {
  readonly status: ConnectionStatus
  readonly transport?: TransportKind | undefined
  readonly host?: TrustedHostProfile | undefined
  readonly epoch?: number | undefined
  readonly detail?: string | undefined
  readonly pairingCandidate?: {
    readonly candidateId: string
    readonly expiresAt: number
    readonly clientFingerprint: string
  } | undefined
}

export type RemoteClientServerNotification =
  | { readonly type: 'stream.event'; readonly sessionId: string; readonly event: OfficialSessionEvent }
  | { readonly type: 'stream.reset'; readonly sessionId: string; readonly reason: string }
  | { readonly type: 'peer.revoked'; readonly reason: string }

export class RemoteRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RemoteRpcError'
  }
}

interface PendingRpc {
  readonly resolve: (val: unknown) => void
  readonly reject: (err: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

const DEFAULT_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const

export class RemoteWebClient {
  private status: ConnectionStatus = 'disconnected'
  private transport: FramedTransport | undefined = undefined
  private noise: NoiseIkInitiator | undefined = undefined
  private activeHost: TrustedHostProfile | undefined = undefined
  private activeTransportKind: TransportKind | undefined = undefined
  private connectionEpoch = 0
  private requestSeq = 0
  private rpcCounter = 0
  private manualDisconnect = false
  private revoked = false
  private connectGeneration = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined = undefined
  private ackFlushTimer: ReturnType<typeof setTimeout> | undefined = undefined
  private pendingAckBySession = new Map<string, number>()
  private highestSeqBySession = new Map<string, number>()
  private pendingRpcs = new Map<string, PendingRpc>()

  private lastConnectOptions: RemoteClientConnectOptions | undefined = undefined

  private readonly statusListeners = new Set<(evt: RemoteClientStatusEvent) => void>()
  private readonly notificationListeners = new Set<(notif: RemoteClientServerNotification) => void>()

  constructor(private readonly keyStore: RemoteWebKeyStore = new RemoteWebKeyStore()) {}

  getStatus(): ConnectionStatus {
    return this.status
  }

  getActiveHost(): TrustedHostProfile | undefined {
    return this.activeHost
  }

  getActiveTransportKind(): TransportKind | undefined {
    return this.activeTransportKind
  }

  getConnectionEpoch(): number {
    return this.connectionEpoch
  }

  onStatus(listener: (evt: RemoteClientStatusEvent) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onNotification(listener: (notif: RemoteClientServerNotification) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  private emitStatus(evt: RemoteClientStatusEvent): void {
    this.status = evt.status
    for (const listener of this.statusListeners) {
      listener(evt)
    }
  }

  private emitNotification(notif: RemoteClientServerNotification): void {
    for (const listener of this.notificationListeners) {
      listener(notif)
    }
  }

  private buildCandidateTransports(
    profile: TrustedHostProfile,
    options: RemoteClientConnectOptions,
  ): FramedTransport[] {
    const candidates: FramedTransport[] = []
    const factory = options.webSocketFactory
    const timeoutMs = options.handshakeTimeoutMs ?? 5_000

    const isSecurePageWithPlainLan =
      typeof globalThis.location !== 'undefined' &&
      globalThis.location.protocol === 'https:' &&
      profile.endpointUrl.startsWith('ws://') &&
      !/^ws:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(profile.endpointUrl)

    // Failover order matches Android & Remote Adapter: LAN -> WebRTC -> Blind Relay
    if (!isSecurePageWithPlainLan) {
      candidates.push(
        createLanWebSocketTransport(profile.endpointUrl, {
          connectTimeoutMs: timeoutMs,
          webSocketFactory: factory,
        }),
      )
    }

    if (profile.signalingUrl) {
      candidates.push(
        createBrowserWebRtcTransport({
          signalingUrl: profile.signalingUrl,
          roomId: profile.signalingRoomId ?? profile.hostFingerprint,
          stunUrls: profile.stunUrls,
          iceConnectTimeoutMs: timeoutMs,
          webSocketFactory: factory,
        }),
      )
    }

    if (profile.relayUrl) {
      candidates.push(
        createBlindRelayWebSocketTransport(
          profile.relayUrl,
          profile.relayRoomId ?? profile.hostFingerprint,
          undefined,
          {
            connectTimeoutMs: timeoutMs,
            webSocketFactory: factory,
          },
        ),
      )
    }

    // If https origin skipped ws:// LAN and zero fallback existed, still attempt LAN so error is explicit
    if (candidates.length === 0) {
      candidates.push(
        createLanWebSocketTransport(profile.endpointUrl, {
          connectTimeoutMs: timeoutMs,
          webSocketFactory: factory,
        }),
      )
    }

    return candidates
  }

  private isConnectGenerationActive(gen: number): boolean {
    return gen === this.connectGeneration && !this.manualDisconnect && !this.revoked
  }

  private async finalizeConnectedProfile(
    effectiveProfile: TrustedHostProfile,
    kind: TransportKind,
    epoch: number,
    allowReset: boolean,
    gen: number,
  ): Promise<TrustedHostProfile> {
    let saved: TrustedHostProfile
    try {
      const storedEpochUpdated = await this.keyStore.updateHostEpoch(
        effectiveProfile.hostFingerprint,
        epoch,
        {
          allowReset,
          profilePatch: {
            ...effectiveProfile,
            preferredTransport: kind,
          },
        },
      )
      if (!this.isConnectGenerationActive(gen)) {
        throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
      }
      if (storedEpochUpdated) {
        saved = storedEpochUpdated
      } else {
        const fresh: TrustedHostProfile = {
          ...effectiveProfile,
          lastEpoch: epoch,
          preferredTransport: kind,
          lastConnectedAt: Date.now(),
        }
        await this.keyStore.saveTrustedHost(fresh, { allowEpochReset: allowReset })
        if (!this.isConnectGenerationActive(gen)) {
          throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
        }
        saved = fresh
      }
    } catch (err) {
      if (err instanceof RemoteRpcError && err.code === 'CANCELLED') {
        throw err
      }
      const msg = sanitizeDiagnosticMessage(err instanceof Error ? err.message : String(err))
      if (msg.includes('Epoch rollback blocked')) {
        this.cleanupTransportOnly()
        const latestHost =
          (await this.keyStore.getTrustedHost(effectiveProfile.hostFingerprint)) ?? effectiveProfile
        this.emitStatus({
          status: 'epoch_mismatch',
          host: latestHost,
          detail: msg,
        })
        throw new RemoteRpcError('EPOCH_DOWNGRADE', msg)
      }
      throw err
    }

    this.activeHost = saved
    this.activeTransportKind = kind
    this.emitStatus({
      status: 'active',
      transport: kind,
      host: saved,
      epoch,
    })
    return saved
  }

  private cleanupTransportOnly(): void {
    if (this.ackFlushTimer) {
      clearTimeout(this.ackFlushTimer)
      this.ackFlushTimer = undefined
    }
    const err = new RemoteRpcError('CONNECTION_CLOSED', 'Remote connection closed')
    for (const [id, pending] of this.pendingRpcs) {
      clearTimeout(pending.timer)
      pending.reject(err)
      this.pendingRpcs.delete(id)
    }
    try {
      this.transport?.close()
    } catch {}
    this.transport = undefined
    this.noise?.close()
    this.noise = undefined
  }

  disconnect(): void {
    this.manualDisconnect = true
    this.connectGeneration += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.cleanupTransportOnly()
    this.activeTransportKind = undefined
    this.emitStatus({
      status: 'disconnected',
      host: this.activeHost,
    })
  }

  async connectWithPairing(
    descriptor: PairingBootstrapDescriptor,
    options: RemoteClientConnectOptions = {},
  ): Promise<TrustedHostProfile> {
    const gen = ++this.connectGeneration
    const existing = await this.keyStore.getTrustedHost(descriptor.hostFingerprint)
    if (gen !== this.connectGeneration) {
      throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
    }
    const profile = descriptorToTrustedProfile(descriptor, existing)
    // Only persist new profile eagerly; for an already trusted host, wait until epoch & handshake verify
    if (!existing) {
      await this.keyStore.saveTrustedHost(profile)
      if (gen !== this.connectGeneration) {
        throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
      }
    }

    return this.connectToProfileInternal(
      profile,
      {
        ...options,
        bootstrapToken: descriptor.bootstrapToken,
        allowEpochReset: options.allowEpochReset === true,
      },
      gen,
    )
  }

  async connectToProfile(
    profile: TrustedHostProfile,
    options: RemoteClientConnectOptions = {},
  ): Promise<TrustedHostProfile> {
    return this.connectToProfileInternal(profile, options, ++this.connectGeneration)
  }

  private async connectToProfileInternal(
    profile: TrustedHostProfile,
    options: RemoteClientConnectOptions,
    gen: number,
  ): Promise<TrustedHostProfile> {
    if (gen !== this.connectGeneration) {
      throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.manualDisconnect = false
    this.revoked = false
    this.cleanupTransportOnly()
    const storedHost = await this.keyStore.getTrustedHost(profile.hostFingerprint)
    if (!this.isConnectGenerationActive(gen)) {
      throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
    }
    const effectiveProfile: TrustedHostProfile =
      storedHost && storedHost.lastEpoch > profile.lastEpoch
        ? { ...profile, lastEpoch: storedHost.lastEpoch }
        : profile
    this.activeHost = effectiveProfile

    // Scrub bootstrap token and one-shot epoch-reset exemption before persisting reconnect options
    let bootstrapToken = options.bootstrapToken
    this.lastConnectOptions = {
      ...options,
      bootstrapToken: undefined,
      allowEpochReset: false,
    }

    const identity = await this.keyStore.getOrCreateClientKeyPair()
    if (!this.isConnectGenerationActive(gen)) {
      throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
    }
    const hostPubBytes = hexToBytes(effectiveProfile.hostPublicKeyHex)
    const pollIntervalMs = options.autoPairPollIntervalMs ?? 1_200

    while (this.isConnectGenerationActive(gen)) {
      this.emitStatus({
        status: 'connecting',
        host: effectiveProfile,
      })

      const candidates = this.buildCandidateTransports(effectiveProfile, options)
      const errors: string[] = []
      let handshakeOutcome:
        | { readonly state: 'ACTIVE' | 'PAIRING_PENDING'; readonly epoch: number; readonly kind: TransportKind }
        | undefined = undefined

      for (const candidate of candidates) {
        if (!this.isConnectGenerationActive(gen)) {
          throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
        }
        try {
          handshakeOutcome = await this.tryConnectSingleTransport(
            candidate,
            identity,
            hostPubBytes,
            effectiveProfile,
            options,
            gen,
          )
          break
        } catch (err) {
          if (!this.isConnectGenerationActive(gen)) {
            throw err instanceof RemoteRpcError && err.code === 'CANCELLED'
              ? err
              : new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
          }
          const msg = sanitizeDiagnosticMessage(err instanceof Error ? err.message : String(err))
          if (err instanceof RemoteRpcError && (err.code === 'EPOCH_DOWNGRADE' || err.code === 'PEER_REVOKED')) {
            this.cleanupTransportOnly()
            this.emitStatus({
              status: err.code === 'PEER_REVOKED' ? 'revoked' : 'epoch_mismatch',
              host: effectiveProfile,
              detail: msg,
            })
            throw err
          }
          errors.push(`${candidate.kind}: ${msg}`)
          this.cleanupTransportOnly()
        }
      }

      if (!this.isConnectGenerationActive(gen)) {
        throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
      }

      if (!handshakeOutcome) {
        const summary = errors.join(' | ') || 'No reachable remote transport'
        this.emitStatus({
          status: 'error',
          host: effectiveProfile,
          detail: summary,
        })
        throw new RemoteRpcError('TRANSPORT_UNAVAILABLE', summary)
      }

      if (handshakeOutcome.state === 'ACTIVE') {
        bootstrapToken = undefined
        return this.finalizeConnectedProfile(
          effectiveProfile,
          handshakeOutcome.kind,
          handshakeOutcome.epoch,
          options.allowEpochReset === true,
          gen,
        )
      }

      // PAIRING_PENDING branch
      if (!bootstrapToken) {
        if (!this.isConnectGenerationActive(gen)) {
          throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
        }
        this.cleanupTransportOnly()
        const msg = 'Device is not authorized on host (PAIRING_PENDING). Pair again using a fresh QR code or link.'
        this.emitStatus({
          status: 'error',
          host: effectiveProfile,
          detail: msg,
        })
        throw new RemoteRpcError('PAIRING_REQUIRED', msg)
      }

      const tokenToSend = bootstrapToken
      bootstrapToken = undefined
      const pairResult = (await this.sendRawPairingRequest(
        tokenToSend,
        options.displayName ?? 'Browser Remote',
        options.requestTimeoutMs ?? 10_000,
      )) as { candidateId: string; expiresAt: number }

      if (!this.isConnectGenerationActive(gen)) {
        throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
      }

      this.emitStatus({
        status: 'pairing',
        transport: handshakeOutcome.kind,
        host: effectiveProfile,
        detail: 'Approve pairing on host...',
        pairingCandidate: {
          candidateId: pairResult.candidateId,
          expiresAt: pairResult.expiresAt,
          clientFingerprint: identity.fingerprint,
        },
      })

      // Host must promote newly approved peer on a fresh connection after confirmPairing
      this.cleanupTransportOnly()
      const waitDeadline = Math.min(pairResult.expiresAt, Date.now() + 180_000)

      while (this.isConnectGenerationActive(gen)) {
        if (Date.now() > waitDeadline) {
          throw new RemoteRpcError('PAIRING_EXPIRED', 'Pairing request expired before host approval')
        }
        await sleep(pollIntervalMs)
        if (!this.isConnectGenerationActive(gen)) {
          throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
        }
        try {
          const recheck = await this.tryConnectFirstReachable(
            effectiveProfile,
            identity,
            hostPubBytes,
            {
              ...options,
              allowEpochReset: options.allowEpochReset === true,
            },
            gen,
          )
          if (!this.isConnectGenerationActive(gen)) {
            throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
          }
          if (recheck.state === 'ACTIVE') {
            return this.finalizeConnectedProfile(
              effectiveProfile,
              recheck.kind,
              recheck.epoch,
              options.allowEpochReset === true,
              gen,
            )
          }
          // Still PAIRING_PENDING — close cleanly and wait next poll
          this.cleanupTransportOnly()
        } catch (err) {
          if (!this.isConnectGenerationActive(gen)) {
            throw err instanceof RemoteRpcError && err.code === 'CANCELLED'
              ? err
              : new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
          }
          this.cleanupTransportOnly()
          if (err instanceof RemoteRpcError && err.code === 'PEER_REVOKED') {
            throw err
          }
        }
      }
    }

    throw new RemoteRpcError('CANCELLED', 'Connection cancelled')
  }

  private async tryConnectFirstReachable(
    profile: TrustedHostProfile,
    identity: { publicKey: Uint8Array; secretKey: Uint8Array },
    hostPubBytes: Uint8Array,
    options: RemoteClientConnectOptions,
    gen: number,
  ): Promise<{ readonly state: 'ACTIVE' | 'PAIRING_PENDING'; readonly epoch: number; readonly kind: TransportKind }> {
    const candidates = this.buildCandidateTransports(profile, options)
    let lastError: Error | undefined
    for (const c of candidates) {
      if (!this.isConnectGenerationActive(gen)) {
        throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
      }
      try {
        return await this.tryConnectSingleTransport(c, identity, hostPubBytes, profile, options, gen)
      } catch (err) {
        if (!this.isConnectGenerationActive(gen)) {
          throw err instanceof RemoteRpcError && err.code === 'CANCELLED'
            ? err
            : new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
        }
        lastError = err instanceof Error ? err : new Error(String(err))
        this.cleanupTransportOnly()
        if (err instanceof RemoteRpcError && (err.code === 'PEER_REVOKED' || err.code === 'EPOCH_DOWNGRADE')) {
          throw err
        }
      }
    }
    throw lastError ?? new Error('No transport reachable')
  }

  private async tryConnectSingleTransport(
    transport: FramedTransport,
    identity: { publicKey: Uint8Array; secretKey: Uint8Array },
    hostPubBytes: Uint8Array,
    profile: TrustedHostProfile,
    options: RemoteClientConnectOptions,
    gen: number,
  ): Promise<{ readonly state: 'ACTIVE' | 'PAIRING_PENDING'; readonly epoch: number; readonly kind: TransportKind }> {
    if (!this.isConnectGenerationActive(gen)) {
      try {
        transport.close()
      } catch {}
      throw new RemoteRpcError('CANCELLED', 'Connection attempt superseded')
    }
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 6_000
    const noise = new NoiseIkInitiator({
      clientKeyPair: identity,
      remoteStaticPublicKey: hostPubBytes,
    })

    this.transport = transport
    this.noise = noise
    this.emitStatus({
      status: 'handshaking',
      transport: transport.kind,
      host: profile,
    })

    return new Promise((resolve, reject) => {
      let stage: 'WAIT_MSG2' | 'WAIT_COMPLETE' | 'ESTABLISHED' = 'WAIT_MSG2'
      let settled = false

      const failHandshake = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        noise.close()
        try {
          transport.close()
        } catch {}
        if (this.transport === transport) {
          this.transport = undefined
          this.noise = undefined
        }
        reject(err)
      }

      const timer = setTimeout(() => {
        failHandshake(
          this.isConnectGenerationActive(gen)
            ? new Error(`Noise handshake timed out on ${transport.kind}`)
            : new RemoteRpcError('CANCELLED', 'Connection attempt superseded'),
        )
      }, handshakeTimeoutMs)

      transport
        .connect({
          onMessage: (frame) => {
            if (this.transport !== transport || !this.isConnectGenerationActive(gen)) {
              if (stage !== 'ESTABLISHED' && !this.isConnectGenerationActive(gen)) {
                failHandshake(new RemoteRpcError('CANCELLED', 'Connection attempt superseded'))
              }
              return
            }

            if (stage === 'WAIT_MSG2') {
              try {
                noise.readMessage2(frame)
                stage = 'WAIT_COMPLETE'
              } catch (err) {
                failHandshake(err instanceof Error ? err : new Error(String(err)))
              }
              return
            }

            let plaintext: Uint8Array
            try {
              plaintext = noise.decrypt(frame)
            } catch (err) {
              const e = err instanceof Error ? err : new Error(String(err))
              if (stage !== 'ESTABLISHED') {
                failHandshake(e)
              } else {
                this.handleUnexpectedDrop(`Decrypt failed: ${e.message}`)
              }
              return
            }

            let msg: Record<string, unknown>
            try {
              msg = JSON.parse(utf8Decode(plaintext)) as Record<string, unknown>
            } catch {
              const e = new Error('Malformed JSON in encrypted frame')
              if (stage !== 'ESTABLISHED') {
                failHandshake(e)
              } else {
                this.handleUnexpectedDrop(e.message)
              }
              return
            }

            if (msg.type === 'peer.revoked') {
              this.revoked = true
              const reason = String(msg.reason ?? 'Device access revoked by host')
              this.emitNotification({ type: 'peer.revoked', reason })
              const revokeErr = new RemoteRpcError('PEER_REVOKED', reason)
              if (stage !== 'ESTABLISHED') {
                failHandshake(revokeErr)
              } else {
                this.cleanupTransportOnly()
                this.emitStatus({ status: 'revoked', host: profile, detail: reason })
              }
              return
            }

            if (stage === 'WAIT_COMPLETE') {
              if (msg.type !== 'handshake.complete' || !Number.isSafeInteger(msg.connectionEpoch)) {
                failHandshake(new Error('Expected handshake.complete frame from host'))
                return
              }
              const epoch = msg.connectionEpoch as number
              const state = msg.state === 'ACTIVE' ? 'ACTIVE' : msg.state === 'PAIRING_PENDING' ? 'PAIRING_PENDING' : undefined
              if (!state) {
                failHandshake(new Error(`Unexpected channel state: ${String(msg.state)}`))
                return
              }

              if (epoch < 1) {
                failHandshake(
                  new RemoteRpcError(
                    'EPOCH_DOWNGRADE',
                    `Host sent invalid connection epoch ${epoch}`,
                  ),
                )
                return
              }

              // Require strict epoch advance unless explicit fresh-pairing reset permitted
              if (profile.lastEpoch > 0 && epoch <= profile.lastEpoch && options.allowEpochReset !== true) {
                failHandshake(
                  new RemoteRpcError(
                    'EPOCH_DOWNGRADE',
                    `Host epoch ${epoch} is not newer than recorded epoch ${profile.lastEpoch}`,
                  ),
                )
                return
              }

              if (!this.isConnectGenerationActive(gen) || this.transport !== transport) {
                failHandshake(new RemoteRpcError('CANCELLED', 'Connection attempt superseded'))
                return
              }

              this.connectionEpoch = epoch
              this.requestSeq = 0
              stage = 'ESTABLISHED'
              settled = true
              clearTimeout(timer)
              resolve({ state, epoch, kind: transport.kind })
              return
            }

            this.handleActiveMessage(msg)
          },
          onError: (err) => {
            if (this.transport !== transport || !this.isConnectGenerationActive(gen)) {
              if (stage !== 'ESTABLISHED' && !this.isConnectGenerationActive(gen)) {
                failHandshake(new RemoteRpcError('CANCELLED', 'Connection attempt superseded'))
              }
              return
            }
            if (stage !== 'ESTABLISHED') {
              failHandshake(err)
            } else {
              this.handleUnexpectedDrop(err.message)
            }
          },
          onClose: (reason) => {
            if (this.transport !== transport || !this.isConnectGenerationActive(gen)) {
              if (stage !== 'ESTABLISHED' && !this.isConnectGenerationActive(gen)) {
                failHandshake(new RemoteRpcError('CANCELLED', 'Connection attempt superseded'))
              }
              return
            }
            if (stage !== 'ESTABLISHED') {
              failHandshake(new Error(reason))
            } else {
              this.handleUnexpectedDrop(reason)
            }
          },
        })
        .then(() => {
          if (settled || this.transport !== transport || !this.isConnectGenerationActive(gen)) {
            if (!settled && !this.isConnectGenerationActive(gen)) {
              failHandshake(new RemoteRpcError('CANCELLED', 'Connection attempt superseded'))
            }
            return
          }
          const msg1 = noise.writeMessage1()
          transport.send(msg1)
        })
        .catch((err) => {
          failHandshake(
            this.isConnectGenerationActive(gen)
              ? err instanceof Error
                ? err
                : new Error(String(err))
              : new RemoteRpcError('CANCELLED', 'Connection attempt superseded'),
          )
        })
    })
  }

  private handleUnexpectedDrop(reason: string): void {
    if (this.manualDisconnect || this.revoked || !this.activeHost) {
      return
    }
    this.cleanupTransportOnly()
    this.activeTransportKind = undefined
    const host = this.activeHost
    const opts = this.lastConnectOptions ?? {}
    this.emitStatus({
      status: 'reconnecting',
      host,
      detail: sanitizeDiagnosticMessage(reason),
    })

    if (this.reconnectTimer) {
      return
    }

    let attempt = 0
    const tryNext = async (): Promise<void> => {
      this.reconnectTimer = undefined
      if (this.manualDisconnect || this.revoked || this.activeHost !== host) return
      try {
        await this.connectToProfile(host, opts)
      } catch (err) {
        if (this.manualDisconnect || this.revoked || this.activeHost !== host) return
        if (
          err instanceof RemoteRpcError &&
          (err.code === 'CANCELLED' ||
            err.code === 'PEER_REVOKED' ||
            err.code === 'PAIRING_REQUIRED' ||
            err.code === 'EPOCH_DOWNGRADE')
        ) {
          return
        }
        attempt += 1
        const delay = DEFAULT_RECONNECT_DELAYS_MS[Math.min(attempt - 1, DEFAULT_RECONNECT_DELAYS_MS.length - 1)]!
        this.emitStatus({
          status: 'reconnecting',
          host,
          detail: `Reconnecting in ${Math.round(delay / 1000)}s...`,
        })
        this.reconnectTimer = setTimeout(() => {
          void tryNext()
        }, delay)
      }
    }

    this.reconnectTimer = setTimeout(() => {
      void tryNext()
    }, DEFAULT_RECONNECT_DELAYS_MS[0])
  }

  private handleActiveMessage(msg: Record<string, unknown>): void {
    if (typeof msg.id === 'string') {
      const pending = this.pendingRpcs.get(msg.id)
      if (!pending) return
      this.pendingRpcs.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.error && typeof msg.error === 'object') {
        const errObj = msg.error as { code?: unknown; name?: unknown; message?: unknown }
        const code = typeof errObj.name === 'string' ? errObj.name : String(errObj.code ?? 'RPC_ERROR')
        pending.reject(new RemoteRpcError(code, String(errObj.message ?? 'Remote error')))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (msg.type === 'stream.event' && typeof msg.sessionId === 'string' && msg.event && typeof msg.event === 'object') {
      const event = msg.event as OfficialSessionEvent
      const prev = this.highestSeqBySession.get(msg.sessionId) ?? 0
      if (typeof event.seq === 'number' && event.seq > prev) {
        this.highestSeqBySession.set(msg.sessionId, event.seq)
        this.queueStreamAck(msg.sessionId, event.seq)
      }
      this.emitNotification({
        type: 'stream.event',
        sessionId: msg.sessionId,
        event,
      })
      return
    }

    if (msg.type === 'stream.reset' && typeof msg.sessionId === 'string') {
      this.emitNotification({
        type: 'stream.reset',
        sessionId: msg.sessionId,
        reason: String(msg.reason ?? 'stream reset'),
      })
    }
  }

  private queueStreamAck(sessionId: string, seq: number): void {
    const existing = this.pendingAckBySession.get(sessionId) ?? 0
    if (seq > existing) {
      this.pendingAckBySession.set(sessionId, seq)
    }
    if (this.ackFlushTimer) return
    this.ackFlushTimer = setTimeout(() => {
      this.ackFlushTimer = undefined
      if (!this.transport?.isOpen() || this.status !== 'active') return
      const entries = [...this.pendingAckBySession.entries()]
      this.pendingAckBySession.clear()
      for (const [sid, s] of entries) {
        void this.request('stream.ack', { sessionId: sid, seq: s }).catch(() => {})
      }
    }, 800)
  }

  private sendRawPairingRequest(token: string, displayName: string, timeoutMs: number): Promise<unknown> {
    if (!this.transport?.isOpen() || !this.noise || this.noise.getState() !== 'READY') {
      return Promise.reject(new RemoteRpcError('NOT_CONNECTED', 'Encrypted channel is not ready'))
    }
    const id = `pair-${++this.rpcCounter}`
    const payload = utf8Encode(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'pairing.request',
        params: { token, displayName },
      }),
    )
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(id)
        reject(new RemoteRpcError('TIMEOUT', 'pairing.request timed out'))
      }, timeoutMs)
      this.pendingRpcs.set(id, { resolve, reject, timer })
      try {
        this.transport!.send(this.noise!.encrypt(payload))
      } catch (err) {
        clearTimeout(timer)
        this.pendingRpcs.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  request(
    method: string,
    params: unknown = {},
    options?: {
      readonly mutating?: boolean | undefined
      readonly idempotencyKey?: string | undefined
      readonly timeoutMs?: number | undefined
    },
  ): Promise<unknown> {
    if (!this.transport?.isOpen() || !this.noise || this.noise.getState() !== 'READY' || this.status !== 'active') {
      return Promise.reject(new RemoteRpcError('NOT_CONNECTED', 'Remote session is not connected'))
    }
    const id = `rpc-${++this.rpcCounter}`
    const seq = ++this.requestSeq
    const mutating = options?.mutating ?? false
    const envelope = {
      jsonrpc: '2.0',
      id,
      method,
      protocolVersion: 1,
      connectionEpoch: this.connectionEpoch,
      requestSeq: seq,
      ...(mutating ? { idempotencyKey: options?.idempotencyKey ?? randomUuid() } : {}),
      params,
    }
    const timeoutMs = options?.timeoutMs ?? 20_000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpcs.delete(id)
        reject(new RemoteRpcError('TIMEOUT', `Request ${method} timed out`))
      }, timeoutMs)
      this.pendingRpcs.set(id, { resolve, reject, timer })
      try {
        const ct = this.noise!.encrypt(utf8Encode(JSON.stringify(envelope)))
        this.transport!.send(ct)
      } catch (err) {
        clearTimeout(timer)
        this.pendingRpcs.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async ping(): Promise<boolean> {
    const res = (await this.request('ping', {})) as { ok?: boolean }
    return res?.ok === true
  }

  async listEngines(): Promise<EngineDescriptor[]> {
    const res = (await this.request('engine.list', {})) as { engines?: EngineDescriptor[] }
    return Array.isArray(res?.engines) ? res.engines : []
  }

  async listSessions(): Promise<SessionRef[]> {
    const res = await this.request('session.list', {})
    return Array.isArray(res) ? (res as SessionRef[]) : []
  }

  async createSession(params: CreateSessionParams = {}): Promise<SessionRef> {
    return (await this.request('session.create', params, { mutating: true })) as SessionRef
  }

  async renameSession(sessionId: string, title: string): Promise<SessionRef> {
    return (await this.request('session.rename', { sessionId, title }, { mutating: true })) as SessionRef
  }

  async forkSession(sessionId: string, options?: { readonly atSeq?: number; readonly title?: string }): Promise<SessionRef> {
    return (await this.request(
      'session.fork',
      {
        sessionId,
        ...(options?.atSeq !== undefined ? { atSeq: options.atSeq } : {}),
        ...(options?.title !== undefined ? { title: options.title } : {}),
      },
      { mutating: true },
    )) as SessionRef
  }

  async searchSessions(query: string, sessionId?: string, limit = 40): Promise<SessionSearchResult> {
    return (await this.request('session.search', {
      query,
      ...(sessionId !== undefined ? { sessionId } : {}),
      limit,
    })) as SessionSearchResult
  }

  async attachSession(sessionId: string, afterSeq?: number): Promise<SessionAttachResult> {
    const res = (await this.request('session.attach', {
      sessionId,
      ...(afterSeq !== undefined ? { afterSeq } : {}),
    })) as SessionAttachResult
    if (res.kind === 'events') {
      for (const ev of res.events) {
        const prev = this.highestSeqBySession.get(sessionId) ?? 0
        if (ev.seq > prev) {
          this.highestSeqBySession.set(sessionId, ev.seq)
        }
      }
    }
    return res
  }

  async getSessionHistory(
    sessionId: string,
    options?: { readonly beforeSeq?: number; readonly limit?: number; readonly minTurns?: number },
  ): Promise<SessionHistoryResult> {
    return (await this.request('session.history', {
      sessionId,
      ...(options?.beforeSeq !== undefined ? { beforeSeq: options.beforeSeq } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      ...(options?.minTurns !== undefined ? { minTurns: options.minTurns } : {}),
    })) as SessionHistoryResult
  }

  async submitPrompt(
    sessionId: string,
    prompt: string,
    options?: {
      readonly mode?: 'followup' | 'steer' | undefined
      readonly attachments?: readonly PromptImageAttachment[] | undefined
      readonly idempotencyKey?: string | undefined
    },
  ): Promise<unknown> {
    const params = {
      sessionId,
      prompt,
      ...(options?.mode !== undefined ? { mode: options.mode } : {}),
      ...(options?.attachments !== undefined && options.attachments.length > 0
        ? { attachments: options.attachments }
        : {}),
    }
    const envelopeBytes = estimateRpcEnvelopeBytes('prompt.submit', params, true)
    if (envelopeBytes > MAX_NOISE_PLAINTEXT_BYTES) {
      throw new RemoteRpcError(
        'FRAME_TOO_LARGE',
        `Prompt payload (${envelopeBytes} bytes) exceeds ${MAX_NOISE_PLAINTEXT_BYTES}-byte Noise encrypted frame limit`,
      )
    }
    return this.request('prompt.submit', params, { mutating: true, idempotencyKey: options?.idempotencyKey })
  }

  async abortTurn(sessionId: string, keepInbox?: boolean): Promise<unknown> {
    return this.request(
      'turn.abort',
      { sessionId, ...(keepInbox !== undefined ? { keepInbox } : {}) },
      { mutating: true },
    )
  }

  async respondApproval(callId: string, decision: 'approved' | 'rejected'): Promise<unknown> {
    return this.request('approval.respond', { callId, decision }, { mutating: true })
  }

  async respondQuestion(questionId: string, answer: unknown): Promise<unknown> {
    return this.request('question.respond', { questionId, answer }, { mutating: true })
  }

  async listModels(sessionId?: string): Promise<ModelCatalogResult> {
    return (await this.request('model.list', sessionId ? { sessionId } : {})) as ModelCatalogResult
  }

  async selectModel(sessionId: string, selection: ModelSelectionParams): Promise<unknown> {
    return this.request(
      'model.select',
      {
        sessionId,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
      },
      { mutating: true },
    )
  }

  async listCommands(sessionId?: string): Promise<RemoteCommandDescriptor[]> {
    const res = (await this.request('command.list', sessionId ? { sessionId } : {})) as {
      commands?: RemoteCommandDescriptor[]
    }
    return Array.isArray(res?.commands) ? res.commands : []
  }

  async executeCommand(sessionId: string, command: string): Promise<{ ok: boolean; output?: string; error?: string }> {
    return (await this.request('command.execute', { sessionId, command }, { mutating: true })) as {
      ok: boolean
      output?: string
      error?: string
    }
  }

  async listSkills(sessionId?: string): Promise<RemoteSkillSummary[]> {
    const res = (await this.request('skill.list', sessionId ? { sessionId } : {})) as {
      skills?: RemoteSkillSummary[]
    }
    return Array.isArray(res?.skills) ? res.skills : []
  }

  async getWorkspaceGitStatus(sessionId: string): Promise<WorkspaceGitStatusResult> {
    return (await this.request('workspace.git.status', { sessionId })) as WorkspaceGitStatusResult
  }

  async getWorkspaceGitDiff(
    sessionId: string,
    options?: { readonly path?: string; readonly staged?: boolean; readonly maxBytes?: number },
  ): Promise<WorkspaceGitDiffResult> {
    return (await this.request('workspace.git.diff', {
      sessionId,
      ...(options?.path !== undefined ? { path: options.path } : {}),
      ...(options?.staged !== undefined ? { staged: options.staged } : {}),
      ...(options?.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    })) as WorkspaceGitDiffResult
  }

  async listWorkspaceFiles(
    sessionId: string,
    options?: { readonly query?: string; readonly prefix?: string; readonly limit?: number },
  ): Promise<WorkspaceFilesResult> {
    return (await this.request('workspace.files', {
      sessionId,
      ...(options?.query !== undefined ? { query: options.query } : {}),
      ...(options?.prefix !== undefined ? { prefix: options.prefix } : {}),
      ...(options?.limit !== undefined ? { limit: options.limit } : {}),
    })) as WorkspaceFilesResult
  }
}

export function buildPromptSubmitSignature(
  mode: 'steer' | 'followup',
  promptText: string,
  attachments: readonly PromptImageAttachment[],
): string {
  return `${mode}\0${promptText}\0${attachments.map((a) => `${a.mediaType}:${a.name ?? ''}:${a.dataBase64}`).join('\0')}`
}

export function estimateRpcEnvelopeBytes(method: string, params: unknown, mutating = true): number {
  const sampleEnvelope = {
    jsonrpc: '2.0',
    id: 'rpc-99999999',
    method,
    protocolVersion: 1,
    connectionEpoch: 999_999_999,
    requestSeq: 999_999_999,
    ...(mutating ? { idempotencyKey: '00000000-0000-4000-8000-000000000000' } : {}),
    params,
  }
  return utf8Encode(JSON.stringify(sampleEnvelope)).byteLength
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
