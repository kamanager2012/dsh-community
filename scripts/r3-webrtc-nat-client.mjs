import { createInterface } from 'node:readline'
// @ts-ignore package-local runtime dependency path is intentional for this evidence script
import dhModule from '../packages/remote-adapter/node_modules/noise-handshake/dh.js'
import {
  WebRtcClientCarrier,
} from '../packages/remote-adapter/dist/index.js'

const dh = dhModule?.default ?? dhModule

const input = createInterface({ input: process.stdin })
const iterator = input[Symbol.asyncIterator]()

async function readCommand() {
  const next = await iterator.next()
  if (next.done) throw new Error('client controller stdin closed')
  return JSON.parse(next.value)
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function seqs(result) {
  return Array.isArray(result?.events)
    ? result.events.map((event) => event.seq)
    : []
}

const config = await readCommand()
const keyPair =
  config.clientPublicKeyHex && config.clientSecretKeyHex
    ? {
        publicKey: new Uint8Array(Buffer.from(config.clientPublicKeyHex, 'hex')),
        secretKey: new Uint8Array(Buffer.from(config.clientSecretKeyHex, 'hex')),
      }
    : (() => {
        const raw = dh.generateKeyPair()
        return {
          publicKey: new Uint8Array(raw.publicKey),
          secretKey: new Uint8Array(raw.secretKey),
        }
      })()

const reconnectDelays = []
const client = new WebRtcClientCarrier({
  clientKeyPair: keyPair,
  hostPublicKey: new Uint8Array(Buffer.from(config.hostPublicKeyHex, 'hex')),
  signalingUrl: config.signalingUrl,
  roomId: config.roomId,
  joinToken: config.joinToken,
  iceConnectTimeoutMs: config.iceConnectTimeoutMs ?? 8000,
  handshakeTimeoutMs: 4000,
  requestTimeoutMs: 4000,
  ice: {
    stunUrls: config.stunUrl ? [config.stunUrl] : undefined,
    iceInterfaceAddresses: config.clientBindIp ? { udp4: config.clientBindIp } : undefined,
    iceStunGatherTimeoutSec: 2,
  },
  sleep: async (ms) => {
    reconnectDelays.push(ms)
    await new Promise((resolve) => setTimeout(resolve, ms))
  },
})

if (config.mode === 'expect-blocked') {
  let errorMessage = ''
  try {
    await client.connect()
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err)
  }
  const openAfterFailure = client.isOpen()
  client.close()
  emit({
    type: 'blocked-result',
    failed: errorMessage.length > 0 && !openAfterFailure,
    openAfterFailure,
    errorMessage,
  })
  input.close()
  process.exit(0)
}

if (config.mode === 'post-signaling') {
  const livePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for post-signaling event')), 4000)
    const unsub = client.onEvent((evt) => {
      if (evt?.type === 'stream.event' && evt?.sessionId === 's1' && evt?.event?.seq === 2) {
        clearTimeout(timer)
        unsub()
        resolve(evt)
      }
    })
  })

  await client.connect()
  emit({
    type: 'connected',
    iceDiagnostics: client.getIceDiagnostics(),
    epoch: client.getConnectionEpoch(),
  })

  const afterSigStop = await readCommand()
  if (afterSigStop.type !== 'signaling-stopped') {
    throw new Error('expected signaling-stopped command')
  }

  const sessions = await client.request('session.list')
  const promptResult = await client.request(
    'prompt.submit',
    { sessionId: 's1', prompt: 'R3_POST_SIG_PROMPT_MARKER' },
    { idempotencyKey: 'r3-post-sig-prompt' },
  )
  const liveEvt = await livePromise
  client.close()

  emit({
    type: 'post-signaling-ok',
    sessions,
    promptResult,
    liveSeq: liveEvt.event?.seq,
    liveMarker: liveEvt.event?.data?.marker,
  })
  input.close()
  process.exit(0)
}

// Default: full dual-NAT E2EE acceptance flow
await client.connect()
const initialIceDiagnostics = client.getIceDiagnostics()
const candidate = await client.request('pairing.request', {
  token: config.token,
  displayName: 'R3 dual-NAT isolated client',
})
emit({
  type: 'candidate',
  candidateId: candidate.candidateId,
  deviceId: client.deviceId,
  iceDiagnostics: initialIceDiagnostics,
})
const confirmed = await readCommand()
if (confirmed.type !== 'confirmed') throw new Error('expected pairing confirmation')
client.close()

await client.reconnectWithBackoff({ initialDelayMs: 25, maxDelayMs: 50, maxAttempts: 3 })
const first = await client.resumeSession('s1')
const firstSeqs = seqs(first)
if (firstSeqs.length > 0) {
  await client.acknowledgeSessionSeq('s1', Math.max(...firstSeqs))
}
emit({
  type: 'first-resume',
  epoch: client.getConnectionEpoch(),
  seqs: firstSeqs,
})
const proceed = await readCommand()
if (proceed.type !== 'continue') throw new Error('expected continue command')

client.close()
await client.reconnectWithBackoff({ initialDelayMs: 25, maxDelayMs: 50, maxAttempts: 3 })
const second = await client.resumeSession('s1')
const secondSeqs = seqs(second)
if (secondSeqs.length > 0) {
  await client.acknowledgeSessionSeq('s1', Math.max(...secondSeqs))
}
emit({
  type: 'second-resume',
  epoch: client.getConnectionEpoch(),
  seqs: secondSeqs,
})

let liveResolve
let liveReject
const liveEventPromise = new Promise((resolve, reject) => {
  liveResolve = resolve
  liveReject = reject
})
const liveTimeout = setTimeout(() => liveReject(new Error('live stream event timeout')), 4000)
const unsubscribeLive = client.onEvent((event) => {
  if (event?.type === 'stream.event' && event?.sessionId === 's1' && event?.event?.seq === 3) {
    clearTimeout(liveTimeout)
    unsubscribeLive()
    liveResolve(event)
  }
})
emit({ type: 'ready-live' })
const liveEvent = await liveEventPromise
await client.acknowledgeSessionSeq('s1', liveEvent.event.seq)
emit({
  type: 'live-event',
  seq: liveEvent.event.seq,
  marker: liveEvent.event.data?.marker,
})

const firstMutation = await client.request(
  'prompt.submit',
  { sessionId: 's1', prompt: 'R3_REAL_PROMPT_MARKER' },
  { idempotencyKey: 'r3-real-idempotency' },
)
client.close()
await client.reconnectWithBackoff({ initialDelayMs: 25, maxDelayMs: 50, maxAttempts: 3 })
const secondMutation = await client.request(
  'prompt.submit',
  { sessionId: 's1', prompt: 'R3_REAL_PROMPT_MARKER' },
  { idempotencyKey: 'r3-real-idempotency' },
)
emit({ type: 'dedupe', firstMutation, secondMutation })

const approvalResult = await client.request(
  'approval.respond',
  {
    callId: 'R3_REAL_APPROVAL_MARKER',
    decision: 'approved',
  },
  { idempotencyKey: 'r3-real-approval' },
)
const sessions = await client.request('session.list')
emit({
  type: 'rpc-ok',
  approvalResult,
  sessions,
})

emit({ type: 'ready-revoke' })
for (let i = 0; i < 300 && client.isOpen(); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
const activeClosed = !client.isOpen()
let revokedDenied = false
const delayStart = reconnectDelays.length
if (activeClosed) {
  try {
    await client.reconnectWithBackoff({
      initialDelayMs: 25,
      maxDelayMs: 50,
      multiplier: 2,
      maxAttempts: 2,
    })
  } catch {
    revokedDenied = true
  }
}
emit({
  type: 'revoked',
  activeClosed,
  denied: revokedDenied,
  reconnectDelays: reconnectDelays.slice(delayStart),
})

client.close()
input.close()
