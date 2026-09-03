import { RemoteCryptoError } from '../crypto/errors.js'

export enum WebSocketOpcode {
  CONTINUATION = 0x0,
  TEXT = 0x1,
  BINARY = 0x2,
  CLOSE = 0x8,
  PING = 0x9,
  PONG = 0xa,
}

export interface WebSocketFrame {
  readonly opcode: WebSocketOpcode
  readonly payload: Uint8Array
}

export interface WebSocketFrameParserCallbacks {
  onFrame: (frame: WebSocketFrame) => void
  onTextFrameRejected: () => void
  onOversizedFrame: (size: number, limit: number) => void
  onProtocolError: (reason: string) => void
}

enum ParserState {
  HEADER = 0,
  EXTENDED_LEN_16 = 1,
  EXTENDED_LEN_64 = 2,
  MASK_KEY = 3,
  PAYLOAD = 4,
}

export class WebSocketFrameParser {
  private state = ParserState.HEADER
  private buffer: Buffer = Buffer.alloc(0)

  private fin = true
  private opcode = WebSocketOpcode.BINARY
  private masked = false
  private payloadLength = 0
  private maskKey: Buffer | undefined = undefined

  constructor(
    private readonly maxFrameBytes: number,
    private readonly requireMask: boolean,
    private readonly callbacks: WebSocketFrameParserCallbacks,
  ) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    this.drain()
  }

  private drain(): void {
    while (this.buffer.length > 0) {
      switch (this.state) {
        case ParserState.HEADER: {
          if (this.buffer.length < 2) return
          const b0 = this.buffer[0]!
          const b1 = this.buffer[1]!

          this.fin = (b0 & 0x80) !== 0
          this.opcode = b0 & 0x0f
          this.masked = (b1 & 0x80) !== 0
          const lenIndicator = b1 & 0x7f

          // Strict binary only: reject text frames immediately
          if (this.opcode === WebSocketOpcode.TEXT) {
            this.callbacks.onTextFrameRejected()
            return
          }

          // RFC 6455 5.1: client-to-server frames must be masked
          if (this.requireMask && !this.masked) {
            this.callbacks.onProtocolError('client-to-server WebSocket frame must be masked')
            return
          }

          this.buffer = this.buffer.subarray(2)

          if (lenIndicator <= 125) {
            this.payloadLength = lenIndicator
            if (this.payloadLength > this.maxFrameBytes) {
              this.callbacks.onOversizedFrame(this.payloadLength, this.maxFrameBytes)
              return
            }
            this.state = this.masked ? ParserState.MASK_KEY : ParserState.PAYLOAD
          } else if (lenIndicator === 126) {
            this.state = ParserState.EXTENDED_LEN_16
          } else {
            this.state = ParserState.EXTENDED_LEN_64
          }
          break
        }

        case ParserState.EXTENDED_LEN_16: {
          if (this.buffer.length < 2) return
          this.payloadLength = this.buffer.readUInt16BE(0)
          this.buffer = this.buffer.subarray(2)

          // Size check BEFORE allocating payload buffer
          if (this.payloadLength > this.maxFrameBytes) {
            this.callbacks.onOversizedFrame(this.payloadLength, this.maxFrameBytes)
            return
          }

          this.state = this.masked ? ParserState.MASK_KEY : ParserState.PAYLOAD
          break
        }

        case ParserState.EXTENDED_LEN_64: {
          if (this.buffer.length < 8) return
          const high = this.buffer.readUInt32BE(0)
          const low = this.buffer.readUInt32BE(4)
          this.buffer = this.buffer.subarray(8)

          const length = high * 0x100000000 + low
          this.payloadLength = length

          // Size check BEFORE allocating payload buffer
          if (this.payloadLength > this.maxFrameBytes) {
            this.callbacks.onOversizedFrame(this.payloadLength, this.maxFrameBytes)
            return
          }

          this.state = this.masked ? ParserState.MASK_KEY : ParserState.PAYLOAD
          break
        }

        case ParserState.MASK_KEY: {
          if (this.buffer.length < 4) return
          this.maskKey = Buffer.from(this.buffer.subarray(0, 4))
          this.buffer = this.buffer.subarray(4)
          this.state = ParserState.PAYLOAD
          break
        }

        case ParserState.PAYLOAD: {
          if (this.buffer.length < this.payloadLength) return

          const payloadBuf = Buffer.allocUnsafe(this.payloadLength)
          this.buffer.copy(payloadBuf, 0, 0, this.payloadLength)
          this.buffer = this.buffer.subarray(this.payloadLength)

          if (this.masked && this.maskKey) {
            for (let i = 0; i < this.payloadLength; i++) {
              payloadBuf[i] = (payloadBuf[i] ?? 0) ^ this.maskKey[i % 4]!
            }
          }

          const payload = new Uint8Array(payloadBuf.buffer, payloadBuf.byteOffset, payloadBuf.byteLength)
          const opcode = this.opcode

          // Reset parser state for next frame
          this.state = ParserState.HEADER
          this.maskKey = undefined
          this.payloadLength = 0

          this.callbacks.onFrame({ opcode, payload })
          break
        }
      }
    }
  }
}

export function encodeWebSocketFrame(
  payload: Uint8Array,
  opcode = WebSocketOpcode.BINARY,
  maskKey?: Uint8Array,
): Buffer {
  const len = payload.byteLength
  let headerLen = 2
  if (maskKey) headerLen += 4

  let lenIndicator = len
  let extLenBytes = 0

  if (len > 65535) {
    lenIndicator = 127
    extLenBytes = 8
  } else if (len > 125) {
    lenIndicator = 126
    extLenBytes = 2
  }

  const frame = Buffer.allocUnsafe(headerLen + extLenBytes + len)
  let offset = 0

  // FIN = 1, RSV = 0, Opcode
  frame[offset++] = 0x80 | (opcode & 0x0f)

  // MASK flag + payload length indicator
  const maskFlag = maskKey ? 0x80 : 0x00
  frame[offset++] = maskFlag | lenIndicator

  if (extLenBytes === 2) {
    frame.writeUInt16BE(len, offset)
    offset += 2
  } else if (extLenBytes === 8) {
    const high = Math.floor(len / 0x100000000)
    const low = len >>> 0
    frame.writeUInt32BE(high, offset)
    frame.writeUInt32BE(low, offset + 4)
    offset += 8
  }

  if (maskKey) {
    frame.set(maskKey, offset)
    offset += 4
    for (let i = 0; i < len; i++) {
      frame[offset + i] = payload[i]! ^ maskKey[i % 4]!
    }
  } else {
    frame.set(payload, offset)
  }

  return frame
}

export function encodeCloseFrame(code = 1000, reason = '', maskKey?: Uint8Array): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8')
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length)
  payload.writeUInt16BE(code, 0)
  reasonBytes.copy(payload, 2)
  return encodeWebSocketFrame(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength), WebSocketOpcode.CLOSE, maskKey)
}

export function parseClosePayload(payload: Uint8Array): { code: number; reason: string } {
  if (payload.byteLength < 2) {
    return { code: 1005, reason: '' }
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const code = view.getUint16(0, false)
  const reason = new TextDecoder().decode(payload.subarray(2))
  return { code, reason }
}
