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
  private rsv = 0
  private opcode = WebSocketOpcode.BINARY
  private masked = false
  private payloadLength = 0
  private maskKey: Buffer | undefined = undefined

  // Fragmentation state
  private fragmentedOpcode: WebSocketOpcode | undefined = undefined
  private fragmentedBuffers: Buffer[] = []
  private fragmentedLength = 0

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

  private isControlOpcode(opcode: WebSocketOpcode): boolean {
    return opcode >= 0x8
  }

  private drain(): void {
    while (this.buffer.length > 0) {
      switch (this.state) {
        case ParserState.HEADER: {
          if (this.buffer.length < 2) return
          const b0 = this.buffer[0]!
          const b1 = this.buffer[1]!

          this.fin = (b0 & 0x80) !== 0
          this.rsv = (b0 & 0x70) >> 4
          this.opcode = b0 & 0x0f
          this.masked = (b1 & 0x80) !== 0
          const lenIndicator = b1 & 0x7f

          // RFC 6455 5.2: RSV bits must be 0 unless extension negotiated
          if (this.rsv !== 0) {
            this.callbacks.onProtocolError('RSV bits must be 0')
            return
          }

          // Strict binary only: reject text frames immediately
          if (this.opcode === WebSocketOpcode.TEXT) {
            this.callbacks.onTextFrameRejected()
            return
          }

          // Control frame checks (RFC 6455 5.5)
          if (this.isControlOpcode(this.opcode)) {
            // Control frames MUST NOT be fragmented
            if (!this.fin) {
              this.callbacks.onProtocolError('control frames must not be fragmented')
              return
            }
            // Control frames payload MUST be <= 125 bytes
            if (lenIndicator > 125) {
              this.callbacks.onProtocolError('control frame payload cannot exceed 125 bytes')
              return
            }
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

          // RFC 6455 5.2: Minimal length encoding check (must be >= 126)
          if (this.payloadLength < 126) {
            this.callbacks.onProtocolError('non-minimal length encoding (expected < 126 to use 7-bit length)')
            return
          }

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

          // Most significant bit must be 0
          if ((high & 0x80000000) !== 0) {
            this.callbacks.onProtocolError('most significant bit in 64-bit length must be 0')
            return
          }

          const length = high * 0x100000000 + low
          this.payloadLength = length

          // RFC 6455 5.2: Minimal length encoding check (must be >= 65536)
          if (length < 65536) {
            this.callbacks.onProtocolError('non-minimal length encoding (expected < 65536 to use 16-bit length)')
            return
          }

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

          const opcode = this.opcode
          const fin = this.fin

          // Reset parser state for next frame
          this.state = ParserState.HEADER
          this.maskKey = undefined
          this.payloadLength = 0

          // Fragmentation handling for data frames
          if (this.isControlOpcode(opcode)) {
            // Control frames are delivered immediately (even in the middle of fragmented data)
            const payload = new Uint8Array(payloadBuf.buffer, payloadBuf.byteOffset, payloadBuf.byteLength)
            this.callbacks.onFrame({ opcode, payload })
          } else if (opcode === WebSocketOpcode.CONTINUATION) {
            if (this.fragmentedOpcode === undefined) {
              this.callbacks.onProtocolError('unexpected continuation frame without initial fragment')
              return
            }
            this.fragmentedLength += payloadBuf.length
            if (this.fragmentedLength > this.maxFrameBytes) {
              this.callbacks.onOversizedFrame(this.fragmentedLength, this.maxFrameBytes)
              return
            }
            this.fragmentedBuffers.push(payloadBuf)

            if (fin) {
              const fullBuffer = Buffer.concat(this.fragmentedBuffers)
              const assembledOpcode = this.fragmentedOpcode
              this.fragmentedBuffers = []
              this.fragmentedLength = 0
              this.fragmentedOpcode = undefined

              const payload = new Uint8Array(fullBuffer.buffer, fullBuffer.byteOffset, fullBuffer.byteLength)
              this.callbacks.onFrame({ opcode: assembledOpcode, payload })
            }
          } else {
            // New data frame (BINARY)
            if (!fin) {
              if (this.fragmentedOpcode !== undefined) {
                this.callbacks.onProtocolError('cannot start new fragmented frame while previous is incomplete')
                return
              }
              this.fragmentedOpcode = opcode
              this.fragmentedBuffers = [payloadBuf]
              this.fragmentedLength = payloadBuf.length
            } else {
              const payload = new Uint8Array(payloadBuf.buffer, payloadBuf.byteOffset, payloadBuf.byteLength)
              this.callbacks.onFrame({ opcode, payload })
            }
          }
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
      frame[offset + i] = (payload[i] ?? 0) ^ (maskKey[i % 4] ?? 0)
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
