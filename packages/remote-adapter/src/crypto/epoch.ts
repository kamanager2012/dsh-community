import type { AuthenticatedPeer } from '../protocol.js'
import { RemoteCryptoError } from './errors.js'

export class ConnectionEpochAllocator {
  private currentEpoch: number

  constructor(initialEpoch = 0) {
    this.currentEpoch = initialEpoch
  }

  allocateNext(): number {
    if (this.currentEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new RemoteCryptoError(
        'STATE_CAPACITY_EXCEEDED',
        'connection epoch space exhausted, connection cannot be established',
      )
    }
    this.currentEpoch += 1
    return this.currentEpoch
  }

  getCurrent(): number {
    return this.currentEpoch
  }

  bindPeer(deviceId: string, epoch: number): AuthenticatedPeer {
    return {
      deviceId,
      connectionEpoch: epoch,
    }
  }
}
