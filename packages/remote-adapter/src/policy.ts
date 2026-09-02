import { RemoteProtocolError } from './errors.js'
import type { Capability, RemoteMethod } from './protocol.js'

interface DeviceRecord {
  readonly capabilities: ReadonlySet<Capability>
  revoked: boolean
}

const requiredCapability: Readonly<Partial<Record<RemoteMethod, Capability>>> = {
  'session.list': 'observe',
  'session.attach': 'observe',
  'prompt.submit': 'prompt',
  'approval.respond': 'approve',
  'question.respond': 'answer-question',
}

export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceRecord>()

  trust(deviceId: string, capabilities: readonly Capability[]): void {
    this.devices.set(deviceId, {
      capabilities: new Set(capabilities),
      revoked: false,
    })
  }

  revoke(deviceId: string): void {
    const record = this.devices.get(deviceId)
    if (record) record.revoked = true
  }

  assertAuthorized(deviceId: string, method: RemoteMethod): void {
    const record = this.devices.get(deviceId)
    if (!record) {
      throw new RemoteProtocolError('DEVICE_UNKNOWN', 'device is not trusted')
    }
    if (record.revoked) {
      throw new RemoteProtocolError('DEVICE_REVOKED', 'device has been revoked')
    }
    const capability = requiredCapability[method]
    if (capability && !record.capabilities.has(capability)) {
      throw new RemoteProtocolError(
        'CAPABILITY_DENIED',
        `device lacks required capability: ${capability}`,
      )
    }
  }
}
