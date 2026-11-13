import type { Socket } from 'node:net'
import { ConnectionEpochAllocator } from '../crypto/epoch.js'
import type { DeviceTrustStore } from '../crypto/device-trust.js'
import type { HostIdentityStore, HostKeyPair } from '../crypto/host-identity.js'
import type { PairingCoordinator } from '../crypto/pairing-coordinator.js'
import type { RemoteAdapterCore } from '../core.js'
import type { AuthenticatedPeer } from '../protocol.js'
import type { LanCarrierBounds } from './constants.js'
import {
  RemoteServerChannel,
  type ConnectionSecurityState,
} from './remote-channel.js'
import type {
  FramedMessageTransport,
  FramedMessageTransportHandlers,
} from './transport.js'
import {
  encodeCloseFrame,
  encodeWebSocketFrame,
  WebSocketFrameParser,
  WebSocketOpcode,
  type WebSocketFrame,
} from './websocket-frame.js'

export type { ConnectionSecurityState } from './remote-channel.js'

export interface LanConnectionContext {
  readonly core: RemoteAdapterCore
  readonly trustStore: DeviceTrustStore
  readonly hostIdentityStore: HostIdentityStore
  readonly hostKeyPair: HostKeyPair
  readonly epochAllocator: ConnectionEpochAllocator
  readonly pairingCoordinator?: PairingCoordinator | undefined
  readonly bounds: LanCarrierBounds
  readonly onPeerAuthenticated: (peer: AuthenticatedPeer, conn: LanConnection) => void
  readonly onClosed: (conn: LanConnection) => void
}

/**
 * WebSocket-over-TCP carrier connection wrapping the shared RemoteServerChannel.
 */
export class LanConnection {
  readonly id: string
  private readonly channel: RemoteServerChannel
  private readonly parser: WebSocketFrameParser
  private handlers: FramedMessageTransportHandlers | undefined = undefined
  private closed = false

  constructor(
    readonly socket: Socket,
    private readonly ctx: LanConnectionContext,
    id: string,
    initialHead?: Buffer,
  ) {
    this.id = id

    const transport: FramedMessageTransport = {
      kind: 'lan',
      isWritable: () => !this.closed && this.socket.writable,
      getBufferedBytes: () => this.socket.writableLength,
      send: (payload, onFlushed) => {
        const frame = encodeWebSocketFrame(payload, WebSocketOpcode.BINARY)
        if (onFlushed) {
          this.socket.write(frame, () => onFlushed())
        } else {
          this.socket.write(frame)
        }
      },
      close: (code = 1000, reason = '') => {
        if (!this.closed) {
          this.closed = true
          try {
            if (this.socket.writable) {
              this.socket.end(encodeCloseFrame(code, reason))
            }
          } catch {}
        }
        const destroyTimer = setTimeout(() => {
          try {
            if (!this.socket.destroyed) {
              this.socket.destroy()
            }
          } catch {}
        }, 50)
        destroyTimer.unref?.()
      },
      setHandlers: (handlers) => {
        this.handlers = handlers
      },
    }

    this.channel = new RemoteServerChannel(
      transport,
      {
        core: ctx.core,
        trustStore: ctx.trustStore,
        hostIdentityStore: ctx.hostIdentityStore,
        hostKeyPair: ctx.hostKeyPair,
        epochAllocator: ctx.epochAllocator,
        pairingCoordinator: ctx.pairingCoordinator,
        bounds: ctx.bounds,
        onPeerAuthenticated: (peer) => {
          this.ctx.onPeerAuthenticated(peer, this)
        },
        onClosed: () => {
          this.ctx.onClosed(this)
        },
      },
      id,
    )

    this.parser = new WebSocketFrameParser(
      ctx.bounds.maxFrameBytes,
      true,
      {
        onFrame: (frame) => this.handleFrame(frame),
        onTextFrameRejected: () => {
          this.terminate(1003, 'text WebSocket frames are strictly forbidden')
        },
        onOversizedFrame: (size, limit) => {
          this.terminate(1009, `frame size (${size}) exceeds limit (${limit})`)
        },
        onProtocolError: (reason) => {
          this.terminate(1002, `protocol error: ${reason}`)
        },
      },
    )

    this.setupSocketListeners()

    if (initialHead && initialHead.length > 0) {
      try {
        this.parser.push(initialHead)
      } catch {
        this.terminate(1008, 'error processing initial head')
      }
    }
  }

  getState(): ConnectionSecurityState {
    return this.channel.getState()
  }

  getPeer(): AuthenticatedPeer | undefined {
    return this.channel.getPeer()
  }

  terminate(code = 1000, reason = ''): void {
    this.channel.terminate(code, reason)
  }

  /**
   * Emits an encrypted `peer.revoked` notification before closing the connection.
   */
  notifyRevoked(reason = 'device revoked', code = 1008): void {
    this.channel.notifyRevoked(reason, code)
  }

  sendEvent(event: unknown): void {
    this.channel.sendEvent(event)
  }

  private setupSocketListeners(): void {
    this.socket.on('data', (chunk: Buffer) => {
      try {
        this.parser.push(chunk)
      } catch {
        this.terminate(1008, 'internal socket processing error')
      }
    })

    this.socket.on('error', (err) => {
      this.closed = true
      this.handlers?.onError(err instanceof Error ? err : new Error(String(err)))
    })

    this.socket.on('close', () => {
      this.closed = true
      this.handlers?.onClose()
    })
  }

  private handleFrame(frame: WebSocketFrame): void {
    if (this.channel.getState() === 'CLOSED') return

    switch (frame.opcode) {
      case WebSocketOpcode.CLOSE: {
        this.terminate(1000, 'client closed')
        return
      }

      case WebSocketOpcode.PING: {
        if (!this.channel.canWriteControlBytes(frame.payload.byteLength)) {
          return
        }
        this.channel.resetIdleTimeout()
        const pong = encodeWebSocketFrame(frame.payload, WebSocketOpcode.PONG)
        const done = this.channel.trackControlSend()
        this.socket.write(pong, () => done())
        return
      }

      case WebSocketOpcode.PONG: {
        this.channel.resetIdleTimeout()
        return
      }

      case WebSocketOpcode.BINARY: {
        this.channel.resetIdleTimeout()
        this.handlers?.onMessage(frame.payload)
        return
      }

      default: {
        this.terminate(1002, `unsupported opcode ${frame.opcode}`)
      }
    }
  }
}
