import {
  RemoteAdapterCore,
  type RemoteAdapterOptions,
} from './core.js'
import type {
  OfficialRemoteSeams,
  OfficialSessionEvent,
} from './protocol.js'
import type { DeviceTrustStore } from './crypto/device-trust.js'
import type { HostIdentityStore } from './crypto/host-identity.js'
import type { PairingCoordinator } from './crypto/pairing-coordinator.js'
import {
  HostLanCarrier,
  type HostLanCarrierOptions,
} from './carrier/lan-host.js'

export interface RemoteHostRuntimeOptions {
  readonly seams: OfficialRemoteSeams
  readonly trustStore: DeviceTrustStore
  readonly hostIdentityStore: HostIdentityStore
  readonly pairingCoordinator?: PairingCoordinator
  readonly coreOptions?: Omit<RemoteAdapterOptions, 'trustStore' | 'hostIdentityStore'>
  readonly carrier: Omit<
    HostLanCarrierOptions,
    'core' | 'trustStore' | 'hostIdentityStore' | 'pairingCoordinator'
  >
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

  forget(sessionId: string): void {
    this.lastSeqBySession.delete(sessionId)
    this.core.forgetSession(sessionId)
  }
}

export class RemoteHostRuntime {
  readonly core: RemoteAdapterCore
  readonly carrier: HostLanCarrier
  readonly events: OfficialSessionEventBridge

  constructor(options: RemoteHostRuntimeOptions) {
    this.core = new RemoteAdapterCore(options.seams, {
      ...(options.coreOptions ?? {}),
      trustStore: options.trustStore,
      hostIdentityStore: options.hostIdentityStore,
    })
    this.carrier = new HostLanCarrier({
      ...options.carrier,
      core: this.core,
      trustStore: options.trustStore,
      hostIdentityStore: options.hostIdentityStore,
      ...(options.pairingCoordinator === undefined
        ? {}
        : { pairingCoordinator: options.pairingCoordinator }),
    })
    this.events = new OfficialSessionEventBridge(
      this.core,
      (sessionId, event) => {
        this.carrier.broadcastEvent({
          type: 'stream.event',
          sessionId,
          event,
        })
      },
    )
  }

  start(): Promise<void> {
    return this.carrier.start()
  }

  stop(): Promise<void> {
    return this.carrier.stop()
  }

  ingestSessionEventBatch(sessionId: string, payload: unknown): number {
    return this.events.ingest(sessionId, payload)
  }

  forgetSession(sessionId: string): void {
    this.events.forget(sessionId)
  }
}
