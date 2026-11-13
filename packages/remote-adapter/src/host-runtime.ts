import {
  RemoteAdapterCore,
  type RemoteAdapterOptions,
} from './core.js'
import type {
  OfficialRemoteSeams,
  OfficialSessionEvent,
} from './protocol.js'
import type { DeviceTrustStore } from './crypto/device-trust.js'
import { ConnectionEpochAllocator } from './crypto/epoch.js'
import type { HostIdentityStore } from './crypto/host-identity.js'
import type { PairingCoordinator } from './crypto/pairing-coordinator.js'
import {
  HostLanCarrier,
  type HostLanCarrierOptions,
} from './carrier/lan-host.js'
import {
  HostRelayCarrier,
  type HostRelayCarrierOptions,
} from './carrier/relay-host.js'
import {
  HostWebRtcCarrier,
  type HostWebRtcCarrierOptions,
} from './carrier/webrtc-host.js'

export interface RemoteHostRuntimeOptions {
  readonly seams: OfficialRemoteSeams
  readonly trustStore: DeviceTrustStore
  readonly hostIdentityStore: HostIdentityStore
  readonly pairingCoordinator?: PairingCoordinator | undefined
  readonly coreOptions?: Omit<RemoteAdapterOptions, 'trustStore' | 'hostIdentityStore'> | undefined
  readonly carrier: Omit<
    HostLanCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  >
  readonly webrtc?: Omit<
    HostWebRtcCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  > | undefined
  readonly relay?: Omit<
    HostRelayCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator' | 'epochAllocator'
  > | undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

export class OfficialSessionEventBridge {
  private readonly lastSeqBySession = new Map<string, number>()

  constructor(
    private readonly core: RemoteAdapterCore,
    private readonly onAcceptedEvent?: (
      sessionId: string,
      event: OfficialSessionEvent,
    ) => void,
    private readonly onResetSession?: (sessionId: string, reason: string) => void,
  ) {}

  ingest(sessionId: string, payload: unknown): number {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('official session id must be a non-empty string')
    }
    const envelope = asRecord(payload)
    if (!envelope || !Array.isArray(envelope.log)) {
      throw new Error('official session/event payload must contain a log array')
    }

    let accepted = 0
    let lastSeq = this.lastSeqBySession.get(sessionId) ?? 0
    for (const item of envelope.log) {
      const event = asRecord(item)
      if (!event) throw new Error('official session/event log item must be an object')
      if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 1) {
        throw new Error('official session/event seq must be a positive safe integer')
      }
      if (typeof event.type !== 'string' || event.type.length === 0) {
        throw new Error('official session/event type must be a non-empty string')
      }
      const seq = event.seq as number
      if (seq <= lastSeq) continue

      const normalized: OfficialSessionEvent = Object.prototype.hasOwnProperty.call(event, 'data')
        ? { seq, type: event.type, data: event.data }
        : { seq, type: event.type }
      this.core.onOfficialEvent(sessionId, normalized)
      this.onAcceptedEvent?.(sessionId, normalized)
      lastSeq = seq
      accepted += 1
    }

    this.lastSeqBySession.set(sessionId, lastSeq)
    return accepted
  }

  forget(sessionId: string, reason = 'window-unavailable'): void {
    this.lastSeqBySession.delete(sessionId)
    this.core.forgetSession(sessionId)
    this.onResetSession?.(sessionId, reason)
  }
}

export class RemoteHostRuntime {
  readonly core: RemoteAdapterCore
  readonly carrier: HostLanCarrier
  readonly webrtc: HostWebRtcCarrier | undefined
  readonly relay: HostRelayCarrier | undefined
  readonly events: OfficialSessionEventBridge
  private readonly epochAllocator = new ConnectionEpochAllocator()

  constructor(options: RemoteHostRuntimeOptions) {
    this.core = new RemoteAdapterCore(options.seams, {
      ...(options.coreOptions ?? {}),
      trustStore: options.trustStore,
      hostIdentityStore: options.hostIdentityStore,
    })
    const carrierShared = {
      core: this.core,
      trustStore: options.trustStore,
      hostIdentityStore: options.hostIdentityStore,
      epochAllocator: this.epochAllocator,
      ...(options.pairingCoordinator === undefined
        ? {}
        : { pairingCoordinator: options.pairingCoordinator }),
    }
    this.carrier = new HostLanCarrier({
      ...options.carrier,
      ...carrierShared,
    })
    this.webrtc =
      options.webrtc !== undefined
        ? new HostWebRtcCarrier({
            ...options.webrtc,
            ...carrierShared,
          })
        : undefined
    this.relay =
      options.relay !== undefined
        ? new HostRelayCarrier({
            ...options.relay,
            ...carrierShared,
          })
        : undefined
    this.events = new OfficialSessionEventBridge(
      this.core,
      (sessionId, event) => {
        this.broadcastFrame({
          type: 'stream.event',
          sessionId,
          event,
        })
      },
      (sessionId, reason) => {
        this.broadcastStreamReset(sessionId, reason)
      },
    )
  }

  async start(): Promise<void> {
    if (this.carrier.isEnabled() || (!this.webrtc?.isEnabled() && !this.relay?.isEnabled())) {
      await this.carrier.start()
    }
    if (this.webrtc?.isEnabled()) {
      try {
        await this.webrtc.start()
      } catch (err) {
        await this.carrier.stop().catch(() => {})
        throw err
      }
    }
    if (this.relay?.isEnabled()) {
      try {
        await this.relay.start()
      } catch (err) {
        await Promise.allSettled([
          this.carrier.stop(),
          this.webrtc ? this.webrtc.stop() : Promise.resolve(),
        ])
        throw err
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.all([
      this.carrier.stop(),
      this.webrtc ? this.webrtc.stop() : Promise.resolve(),
      this.relay ? this.relay.stop() : Promise.resolve(),
    ])
  }

  ingestSessionEventBatch(sessionId: string, payload: unknown): number {
    return this.events.ingest(sessionId, payload)
  }

  forgetSession(sessionId: string, reason = 'window-unavailable'): void {
    this.events.forget(sessionId, reason)
  }

  /**
   * Emits an encrypted `stream.reset` notification to all active clients
   * across enabled carriers so stale buffered events can be discarded cleanly.
   */
  broadcastStreamReset(sessionId: string, reason = 'window-unavailable'): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    this.broadcastFrame({
      type: 'stream.reset',
      sessionId,
      reason,
    })
  }

  private broadcastFrame(frame: unknown): void {
    this.carrier.broadcastEvent(frame)
    this.webrtc?.broadcastEvent(frame)
    this.relay?.broadcastEvent(frame)
  }
}
