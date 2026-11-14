import { concatBytes, utf8Decode, utf8Encode } from '../crypto/bytes.ts'
import { validateStunOnlyUrls } from './pairing.ts'
import type { TransportKind } from './types.ts'

export const DSH_WEBRTC_DATA_CHANNEL_LABEL = 'dsh-remote-v1'
export const DEFAULT_WEBRTC_CHUNK_BYTES = 16_000
export const MAX_TRANSPORT_FRAME_BYTES = 65_535

const CHUNK_SINGLE = 0x00
const CHUNK_MORE = 0x01
const CHUNK_FINAL = 0x02

export interface FramedTransportHandlers {
  readonly onMessage: (payload: Uint8Array) => void
  readonly onError: (error: Error) => void
  readonly onClose: (reason: string) => void
}

export interface FramedTransport {
  readonly kind: TransportKind
  isOpen(): boolean
  connect(handlers: FramedTransportHandlers): Promise<void>
  send(payload: Uint8Array): void
  close(code?: number, reason?: string): void
}

export interface WebSocketLike {
  binaryType: BinaryType
  readonly readyState: number
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string | ArrayBufferLike | ArrayBufferView): void
  close(code?: number, reason?: string): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

const defaultWebSocketFactory: WebSocketFactory = (url: string) => {
  const ctor = globalThis.WebSocket
  if (typeof ctor !== 'function') {
    throw new Error('WebSocket is unavailable in this environment')
  }
  return new ctor(url) as unknown as WebSocketLike
}

async function normalizeBinaryEventData(data: unknown): Promise<Uint8Array> {
  if (data instanceof Uint8Array) {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer())
  }
  throw new Error('Expected binary WebSocket frame')
}

function enqueueBinaryDelivery(
  chain: Promise<void>,
  data: unknown,
  deliver: (bytes: Uint8Array) => void,
  onError: (err: Error) => void,
): Promise<void> {
  // Preserve strict FIFO frame ordering if Blob.arrayBuffer() resolves asynchronously
  if (!(typeof Blob !== 'undefined' && data instanceof Blob)) {
    try {
      if (data instanceof Uint8Array) {
        deliver(data)
      } else if (data instanceof ArrayBuffer) {
        deliver(new Uint8Array(data))
      } else if (ArrayBuffer.isView(data)) {
        deliver(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      } else {
        throw new Error('Expected binary WebSocket frame')
      }
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)))
    }
    return chain
  }

  return chain.then(async () => {
    try {
      const bytes = await normalizeBinaryEventData(data)
      deliver(bytes)
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

export function createLanWebSocketTransport(
  endpointUrl: string,
  options?: {
    readonly connectTimeoutMs?: number | undefined
    readonly webSocketFactory?: WebSocketFactory | undefined
  },
): FramedTransport {
  const wsFactory = options?.webSocketFactory ?? defaultWebSocketFactory
  const connectTimeoutMs = options?.connectTimeoutMs ?? 5_000
  let activeWs: WebSocketLike | undefined = undefined
  let isOpened = false
  let inboundQueue = Promise.resolve()

  return {
    kind: 'lan',
    isOpen: () => activeWs !== undefined && isOpened && activeWs.readyState === 1,
    connect: (handlers) =>
      new Promise<void>((resolve, reject) => {
        let ws: WebSocketLike
        try {
          ws = wsFactory(endpointUrl)
          ws.binaryType = 'arraybuffer'
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
          return
        }
        activeWs = ws
        isOpened = false
        let settled = false

        const cleanupEarly = (err: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (activeWs === ws) {
            activeWs = undefined
            isOpened = false
          }
          try {
            ws.close()
          } catch {}
          reject(err)
        }

        const timer = setTimeout(() => {
          cleanupEarly(new Error(`LAN WebSocket connect timeout (${connectTimeoutMs}ms)`))
        }, connectTimeoutMs)

        ws.onopen = () => {
          if (settled) return
          settled = true
          isOpened = true
          clearTimeout(timer)
          resolve()
        }

        ws.onmessage = (event) => {
          if (activeWs !== ws) return
          if (typeof event.data === 'string') {
            const err = new Error('Unexpected text WebSocket frame on LAN Noise channel')
            handlers.onError(err)
            try {
              ws.close(1003, 'binary ciphertext only')
            } catch {}
            return
          }
          inboundQueue = enqueueBinaryDelivery(
            inboundQueue,
            event.data,
            (bytes) => {
              if (activeWs === ws) {
                handlers.onMessage(bytes)
              }
            },
            handlers.onError,
          )
        }

        ws.onerror = (evt) => {
          const msg = String((evt as { message?: unknown })?.message ?? 'LAN WebSocket connection failed')
          const err = new Error(msg)
          if (!isOpened) {
            cleanupEarly(err)
          } else {
            handlers.onError(err)
          }
        }

        ws.onclose = (event) => {
          const wasOpen = isOpened
          if (activeWs === ws) {
            activeWs = undefined
            isOpened = false
          }
          const reason = `LAN WebSocket closed (code ${event.code}: ${event.reason || 'closed'})`
          if (!wasOpen) {
            cleanupEarly(new Error(reason))
          } else {
            handlers.onClose(reason)
          }
        }
      }),
    send: (payload) => {
      if (!activeWs || !isOpened || activeWs.readyState !== 1) {
        throw new Error('LAN WebSocket transport is not open')
      }
      activeWs.send(payload)
    },
    close: (code, reason) => {
      const ws = activeWs
      activeWs = undefined
      isOpened = false
      if (ws) {
        try {
          ws.close(code, reason)
        } catch {}
      }
    },
  }
}

export function createBlindRelayWebSocketTransport(
  relayUrl: string,
  roomId: string,
  clientToken?: string,
  options?: {
    readonly connectTimeoutMs?: number | undefined
    readonly webSocketFactory?: WebSocketFactory | undefined
  },
): FramedTransport {
  const wsFactory = options?.webSocketFactory ?? defaultWebSocketFactory
  const connectTimeoutMs = options?.connectTimeoutMs ?? 7_000
  let activeWs: WebSocketLike | undefined = undefined
  let joined = false
  let inboundQueue = Promise.resolve()

  return {
    kind: 'relay',
    isOpen: () => activeWs !== undefined && joined && activeWs.readyState === 1,
    connect: (handlers) =>
      new Promise<void>((resolve, reject) => {
        let ws: WebSocketLike
        try {
          ws = wsFactory(relayUrl)
          ws.binaryType = 'arraybuffer'
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
          return
        }
        activeWs = ws
        joined = false
        let settled = false

        const failEarly = (err: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (activeWs === ws) {
            activeWs = undefined
            joined = false
          }
          try {
            ws.close()
          } catch {}
          reject(err)
        }

        const timer = setTimeout(() => {
          failEarly(new Error(`Blind relay join timeout (${connectTimeoutMs}ms)`))
        }, connectTimeoutMs)

        ws.onopen = () => {
          try {
            ws.send(
              utf8Encode(
                JSON.stringify({
                  v: 1,
                  type: 'relay.client.join',
                  roomId,
                  ...(clientToken !== undefined ? { clientToken } : {}),
                }),
              ),
            )
          } catch (err) {
            failEarly(err instanceof Error ? err : new Error(String(err)))
          }
        }

        ws.onmessage = (event) => {
          if (activeWs !== ws) return
          if (!joined) {
            const handleJoinFrame = async () => {
              const rawText =
                typeof event.data === 'string'
                  ? event.data
                  : utf8Decode(await normalizeBinaryEventData(event.data))
              const msg = JSON.parse(rawText) as Record<string, unknown>
              if (msg.type === 'error') {
                failEarly(
                  new Error(`Blind relay join failed: ${String(msg.code ?? 'ERROR')} ${String(msg.message ?? '')}`),
                )
                return
              }
              if (msg.type === 'relay.client.joined' && msg.roomId === roomId) {
                settled = true
                joined = true
                clearTimeout(timer)
                resolve()
              }
            }
            void handleJoinFrame().catch((err) => {
              failEarly(err instanceof Error ? err : new Error(String(err)))
            })
            return
          }

          if (typeof event.data === 'string') {
            const err = new Error('Unexpected text frame in blind relay binary mode')
            handlers.onError(err)
            try {
              ws.close(1003, 'binary ciphertext only')
            } catch {}
            return
          }

          inboundQueue = enqueueBinaryDelivery(
            inboundQueue,
            event.data,
            (bytes) => {
              if (activeWs === ws && joined) {
                handlers.onMessage(bytes)
              }
            },
            handlers.onError,
          )
        }

        ws.onerror = (evt) => {
          const msg = String((evt as { message?: unknown })?.message ?? 'Blind relay WebSocket error')
          const err = new Error(msg)
          if (!joined) {
            failEarly(err)
          } else {
            handlers.onError(err)
          }
        }

        ws.onclose = (event) => {
          const wasJoined = joined
          if (activeWs === ws) {
            activeWs = undefined
            joined = false
          }
          const reason = `Blind relay closed (code ${event.code}: ${event.reason || 'closed'})`
          if (!wasJoined) {
            failEarly(new Error(reason))
          } else {
            handlers.onClose(reason)
          }
        }
      }),
    send: (payload) => {
      if (!activeWs || !joined || activeWs.readyState !== 1) {
        throw new Error('Blind relay transport is not open')
      }
      activeWs.send(payload)
    },
    close: (code, reason) => {
      const ws = activeWs
      activeWs = undefined
      joined = false
      if (ws) {
        try {
          ws.close(code, reason)
        } catch {}
      }
    },
  }
}

export function encodeDataChannelChunks(
  payload: Uint8Array,
  chunkSize: number = DEFAULT_WEBRTC_CHUNK_BYTES,
): Uint8Array[] {
  if (payload.byteLength <= chunkSize) {
    const out = new Uint8Array(1 + payload.byteLength)
    out[0] = CHUNK_SINGLE
    out.set(payload, 1)
    return [out]
  }
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < payload.byteLength; offset += chunkSize) {
    const end = Math.min(payload.byteLength, offset + chunkSize)
    const isFinal = end >= payload.byteLength
    const slice = payload.subarray(offset, end)
    const frame = new Uint8Array(1 + slice.byteLength)
    frame[0] = isFinal ? CHUNK_FINAL : CHUNK_MORE
    frame.set(slice, 1)
    chunks.push(frame)
  }
  return chunks
}

export class DataChannelFrameReassembler {
  private chunks: Uint8Array[] = []
  private totalBytes = 0

  constructor(private readonly maxFrameBytes: number = MAX_TRANSPORT_FRAME_BYTES) {}

  push(bytes: Uint8Array): Uint8Array | undefined {
    if (bytes.byteLength < 1) {
      throw new Error('Empty DataChannel frame chunk')
    }
    const marker = bytes[0]
    const slice = bytes.subarray(1)

    if (marker === CHUNK_SINGLE) {
      if (this.chunks.length > 0) {
        this.reset()
        throw new Error('Unexpected CHUNK_SINGLE during multipart DataChannel frame')
      }
      if (slice.byteLength > this.maxFrameBytes) {
        throw new Error('DataChannel frame exceeds maxFrameBytes')
      }
      return slice
    }

    if (marker !== CHUNK_MORE && marker !== CHUNK_FINAL) {
      this.reset()
      throw new Error(`Unknown DataChannel chunk marker ${marker}`)
    }

    if (this.totalBytes + slice.byteLength > this.maxFrameBytes) {
      this.reset()
      throw new Error('Reassembled DataChannel frame exceeds maxFrameBytes')
    }

    this.chunks.push(slice)
    this.totalBytes += slice.byteLength
    if (marker === CHUNK_MORE) {
      return undefined
    }
    const assembled = concatBytes(...this.chunks)
    this.reset()
    return assembled
  }

  reset(): void {
    this.chunks = []
    this.totalBytes = 0
  }
}

function isAllowedCandidateString(candidate: string | null | undefined): boolean {
  if (!candidate) return true
  // Enforce R3: never signal or accept third-party/RELAY ICE candidates
  return !/\btyp relay\b/i.test(candidate)
}

export function createBrowserWebRtcTransport(options: {
  readonly signalingUrl: string
  readonly roomId: string
  readonly stunUrls?: readonly string[] | undefined
  readonly joinToken?: string | undefined
  readonly iceConnectTimeoutMs?: number | undefined
  readonly webSocketFactory?: WebSocketFactory | undefined
}): FramedTransport {
  const validatedStunUrls = validateStunOnlyUrls(options.stunUrls) ?? []
  const wsFactory = options.webSocketFactory ?? defaultWebSocketFactory
  const connectTimeoutMs = options.iceConnectTimeoutMs ?? 7_500

  let activePc: RTCPeerConnection | undefined = undefined
  let activeDc: RTCDataChannel | undefined = undefined
  let activeSignaling: WebSocketLike | undefined = undefined

  return {
    kind: 'webrtc',
    isOpen: () => activeDc !== undefined && activeDc.readyState === 'open',
    connect: (handlers) => {
      if (typeof globalThis.RTCPeerConnection !== 'function') {
        return Promise.reject(new Error('WebRTC RTCPeerConnection is unavailable in this environment'))
      }

      const pc = new globalThis.RTCPeerConnection({
        iceServers: validatedStunUrls.map((url) => ({ urls: url })),
        iceTransportPolicy: 'all',
      })
      const dc = pc.createDataChannel(DSH_WEBRTC_DATA_CHANNEL_LABEL, { ordered: true })
      dc.binaryType = 'arraybuffer'
      activePc = pc
      activeDc = dc

      const reassembler = new DataChannelFrameReassembler(MAX_TRANSPORT_FRAME_BYTES)
      const remoteIceQueue: (RTCIceCandidateInit | null)[] = []
      const localIceBuffer: (RTCIceCandidateInit | null)[] = []
      let remoteDescSet = false
      let hostPeerId: string | undefined = undefined
      let offerSent = false
      let opened = false
      let closed = false
      let inboundQueue = Promise.resolve()

      const cleanupLocal = (): void => {
        closed = true
        reassembler.reset()
        if (activeDc === dc) activeDc = undefined
        if (activePc === pc) activePc = undefined
        const sig = activeSignaling
        activeSignaling = undefined
        try {
          sig?.close()
        } catch {}
        try {
          dc.close()
        } catch {}
        try {
          pc.close()
        } catch {}
      }

      return new Promise<void>((resolve, reject) => {
        let settled = false

        const failConnect = (err: Error): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          cleanupLocal()
          reject(err)
        }

        const timer = setTimeout(() => {
          failConnect(new Error(`WebRTC DataChannel timeout (${connectTimeoutMs}ms)`))
        }, connectTimeoutMs)

        let sigWs: WebSocketLike
        try {
          sigWs = wsFactory(options.signalingUrl)
          sigWs.binaryType = 'arraybuffer'
          activeSignaling = sigWs
        } catch (err) {
          failConnect(err instanceof Error ? err : new Error(String(err)))
          return
        }

        const sendSignal = (payload: Record<string, unknown>): void => {
          if (sigWs.readyState !== 1) {
            throw new Error('Signaling WebSocket is not open')
          }
          sigWs.send(utf8Encode(JSON.stringify(payload)))
        }

        const flushRemoteIce = async (): Promise<void> => {
          while (remoteIceQueue.length > 0 && !closed) {
            const cand = remoteIceQueue.shift()
            if (!cand) continue
            try {
              await pc.addIceCandidate(cand)
            } catch {}
          }
        }

        pc.onicecandidate = (evt) => {
          if (closed) return
          const payload: RTCIceCandidateInit | null = evt.candidate ? evt.candidate.toJSON() : null
          if (payload && !isAllowedCandidateString(payload.candidate)) {
            return
          }
          if (!offerSent || !hostPeerId || sigWs.readyState !== 1) {
            localIceBuffer.push(payload)
            return
          }
          try {
            sendSignal({
              v: 1,
              type: 'rtc.ice',
              roomId: options.roomId,
              toPeerId: hostPeerId,
              candidate: payload,
            })
          } catch {}
        }

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            const err = new Error(`WebRTC connection ${pc.connectionState}`)
            if (!opened) {
              failConnect(err)
            } else {
              cleanupLocal()
              handlers.onClose(err.message)
            }
          }
        }

        dc.onmessage = (evt) => {
          if (closed) return
          if (typeof evt.data === 'string') {
            handlers.onError(new Error('Text DataChannel frames are forbidden'))
            cleanupLocal()
            return
          }
          inboundQueue = enqueueBinaryDelivery(
            inboundQueue,
            evt.data,
            (chunkBytes) => {
              if (closed) return
              const assembled = reassembler.push(chunkBytes)
              if (assembled !== undefined) {
                handlers.onMessage(assembled)
              }
            },
            (err) => {
              handlers.onError(err)
              cleanupLocal()
            },
          )
        }

        dc.onerror = () => {
          const err = new Error('WebRTC DataChannel error')
          if (!opened) {
            failConnect(err)
          } else {
            handlers.onError(err)
          }
        }

        dc.onclose = () => {
          if (!opened) {
            failConnect(new Error('WebRTC DataChannel closed before open'))
            return
          }
          if (!closed) {
            cleanupLocal()
            handlers.onClose('WebRTC DataChannel closed')
          }
        }

        const markOpen = (): void => {
          if (settled || closed) return
          settled = true
          opened = true
          clearTimeout(timer)
          try {
            sigWs.close()
          } catch {}
          if (activeSignaling === sigWs) {
            activeSignaling = undefined
          }
          resolve()
        }

        if (dc.readyState === 'open') {
          markOpen()
        } else {
          dc.onopen = markOpen
        }

        sigWs.onopen = () => {
          try {
            sendSignal({
              v: 1,
              type: 'client.join',
              roomId: options.roomId,
              ...(options.joinToken !== undefined ? { joinToken: options.joinToken } : {}),
            })
          } catch (err) {
            failConnect(err instanceof Error ? err : new Error(String(err)))
          }
        }

        sigWs.onerror = () => {
          if (!opened) {
            failConnect(new Error('Signaling WebSocket connection failed'))
          }
        }

        sigWs.onclose = () => {
          if (!opened) {
            failConnect(new Error('Signaling WebSocket closed before WebRTC open'))
          }
        }

        sigWs.onmessage = (evt) => {
          if (closed) return
          const handleSignal = async (): Promise<void> => {
            const raw =
              typeof evt.data === 'string'
                ? evt.data
                : utf8Decode(await normalizeBinaryEventData(evt.data))
            const msg = JSON.parse(raw) as Record<string, unknown>

            if (msg.type === 'error') {
              failConnect(new Error(`Signaling rejected: ${String(msg.code ?? 'ERROR')} ${String(msg.message ?? '')}`))
              return
            }

            if (msg.type === 'client.joined') {
              hostPeerId = String(msg.hostPeerId ?? '')
              if (!hostPeerId) {
                failConnect(new Error('Signaling hostPeerId unavailable'))
                return
              }
              const offer = await pc.createOffer()
              await pc.setLocalDescription(offer)
              if (closed) return
              sendSignal({
                v: 1,
                type: 'rtc.offer',
                roomId: options.roomId,
                toPeerId: hostPeerId,
                sdp: { type: offer.type, sdp: offer.sdp ?? '' },
              })
              offerSent = true
              for (const cand of localIceBuffer) {
                try {
                  sendSignal({
                    v: 1,
                    type: 'rtc.ice',
                    roomId: options.roomId,
                    toPeerId: hostPeerId,
                    candidate: cand,
                  })
                } catch {}
              }
              localIceBuffer.length = 0
              return
            }

            if (msg.type === 'rtc.answer' && msg.sdp) {
              const sdp = msg.sdp as RTCSessionDescriptionInit
              await pc.setRemoteDescription(sdp)
              remoteDescSet = true
              await flushRemoteIce()
              return
            }

            if (msg.type === 'rtc.ice' && msg.candidate !== undefined) {
              const cand = msg.candidate as RTCIceCandidateInit | null
              if (cand && !isAllowedCandidateString(cand.candidate)) {
                return
              }
              remoteIceQueue.push(cand)
              if (remoteDescSet) {
                await flushRemoteIce()
              }
            }
          }

          void handleSignal().catch((err) => {
            if (!opened) {
              failConnect(err instanceof Error ? err : new Error(String(err)))
            }
          })
        }
      })
    },
    send: (payload) => {
      if (!activeDc || activeDc.readyState !== 'open') {
        throw new Error('WebRTC DataChannel is not open')
      }
      if (payload.byteLength > MAX_TRANSPORT_FRAME_BYTES) {
        throw new Error('Outbound WebRTC frame exceeds maxFrameBytes')
      }
      for (const chunk of encodeDataChannelChunks(payload)) {
        const view = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        activeDc.send(view as unknown as ArrayBuffer)
      }
    },
    close: () => {
      const dc = activeDc
      const pc = activePc
      const sig = activeSignaling
      activeDc = undefined
      activePc = undefined
      activeSignaling = undefined
      try {
        sig?.close()
      } catch {}
      try {
        dc?.close()
      } catch {}
      try {
        pc?.close()
      } catch {}
    },
  }
}
