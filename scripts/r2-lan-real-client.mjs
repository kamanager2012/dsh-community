import { createInterface } from 'node:readline'
import { Socket } from 'node:net'
// @ts-ignore package-local runtime dependency path is intentional for this evidence script
import dhModule from '../packages/remote-adapter/node_modules/noise-handshake/dh.js'
import {
  LanClientCarrier,
} from '../packages/remote-adapter/dist/index.js'

const dh = dhModule?.default ?? dhModule

const input = createInterface({ input: process.stdin })
const iterator = input[Symbol.asyncIterator]()

async function readCommand() {
  const next = await iterator.next()
  if (next.done) throw new Error('acceptance controller stdin closed')
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
const raw = dh.generateKeyPair()
const keyPair = {
  publicKey: new Uint8Array(raw.publicKey),
  secretKey: new Uint8Array(raw.secretKey),
}
const reconnectDelays = []
const client = new LanClientCarrier({
  clientKeyPair: keyPair,
  hostPublicKey: new Uint8Array(Buffer.from(config.hostPublicKeyHex, 'hex')),
  endpointUrl: config.endpointUrl,
  handshakeTimeoutMs: 1000,
  requestTimeoutMs: 2000,
  sleep: async (ms) => {
    reconnectDelays.push(ms)
    await new Promise((resolve) => setTimeout(resolve, ms))
  },
})

await client.connect()
const candidate = await client.request('pairing.request', {
  token: config.token,
  displayName: 'R2 isolated native client',
})
emit({ type: 'candidate', candidateId: candidate.candidateId, deviceId: client.deviceId })
const confirmed = await readCommand()
if (confirmed.type !== 'confirmed') throw new Error('expected pairing confirmation')
client.close()

await client.reconnectWithBackoff({ initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 3 })
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
await client.reconnectWithBackoff({ initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 3 })
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
const liveTimeout = setTimeout(() => liveReject(new Error('live stream event timeout')), 3000)
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
emit({ type: 'live-event', seq: liveEvent.event.seq, marker: liveEvent.event.data?.marker })

const firstMutation = await client.request(
  'prompt.submit',
  { sessionId: 's1', prompt: 'R2_REAL_PROMPT_MARKER' },
  { idempotencyKey: 'r2-real-idempotency' },
)
client.close()
await client.reconnectWithBackoff({ initialDelayMs: 20, maxDelayMs: 40, maxAttempts: 3 })
const secondMutation = await client.request(
  'prompt.submit',
  { sessionId: 's1', prompt: 'R2_REAL_PROMPT_MARKER' },
  { idempotencyKey: 'r2-real-idempotency' },
)
emit({ type: 'dedupe', firstMutation, secondMutation })

emit({ type: 'ready-revoke' })
for (let i = 0; i < 200 && client.isOpen(); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}
const activeClosed = !client.isOpen()
let revokedDenied = false
const delayStart = reconnectDelays.length
if (activeClosed) {
  try {
    await client.reconnectWithBackoff({
      initialDelayMs: 20,
      maxDelayMs: 40,
      multiplier: 2,
      maxAttempts: 3,
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

const endpoint = new URL(config.endpointUrl)
const stalled = []
for (let i = 0; i < 8; i += 1) {
  const socket = new Socket()
  socket.on('error', () => {})
  socket.connect(Number(endpoint.port), endpoint.hostname)
  stalled.push(socket)
}
await new Promise((resolve) => setTimeout(resolve, 80))
emit({ type: 'stalled-open' })
const stalledCheck = await readCommand()
if (stalledCheck.type !== 'stalled-check') throw new Error('expected stalled-check command')
await new Promise((resolve) => setTimeout(resolve, 500))
for (const socket of stalled) socket.destroy()
emit({ type: 'stalled-done' })
client.close()
input.close()
