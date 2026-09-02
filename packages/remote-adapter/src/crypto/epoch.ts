import type { AuthenticatedPeer } from '../protocol.js'

export class ConnectionEpochAllocator {
  private currentEpoch = 0

  allocateNext(): number {
    this.currentEpoch += 1
    if (this.currentEpoch > Number.MAX_SAFE_INTEGER) {
      this.currentEpoch = 1
    }
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
