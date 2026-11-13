import { createInterface } from 'node:readline'
// @ts-ignore package-local runtime dependency path is intentional for this evidence script
import dhModule from '../packages/remote-adapter/node_modules/noise-handshake/dh.js'
import { FailoverRemoteClient } from '../packages/remote-adapter/dist/index.js'

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
const raw = dh.generateKeyPair()
const keyPair = {
  publicKey: new Uint8Array(raw.publicKey),
  secretKey: new Uint8Array(raw.secretKey),
}

const reconnectDelays = []
const client = new FailoverRemoteClient({
  clientKeyPair: keyPair,
  hostPublicKey: new Uint8Array(Buffer.from(config.hostPublicKeyHex, 'hex')),
  priorityOrder: ['lan', 'webrtc', 'relay'],
  lan: { endpointUrl: config.lanEndpointUrl },
  webrtc: {
    signalingUrl: config.signalingUrl,
    roomId: config.webrtcRoomId,
    joinToken: config.webrtcJoinToken,
    iceConnectTimeoutMs: config.iceConnectTimeoutMs ?? 2500,
    ice: {
      stunUrls: config.stunUrl ? [config.stunUrl] : undefined,
      iceInterfaceAddresses: config.clientBindIp ? { udp4: config.clientBindIp } : undefined,
      iceStunGatherTimeoutSec: 1,
    },
  },
  relay: {
    relayUrl: config.relayUrl,
    roomId: config.relayRoomId,
    clientToken: config.relayClientToken,
    connectTimeoutMs: 4000,
  },
  handshakeTimeoutMs: 1200,
  requestTimeoutMs: 4000,
  sleep: async (ms) => {
    reconnectDelays.push(ms)
    await new Promise((resolve) => setTimeout(resolve, ms))
  },
})

try {
  // 1. Failover LAN (blocked) -> WebRTC (blocked) -> Relay (connected) before pairing
  await client.connect()
  const initialTransport = client.getActiveTransportKind()
  const initialHistory = client.getFailoverHistory()

  let unauthRejected = false
  try {
    await client.request('session.list')
  } catch {
    unauthRejected = true
  }

  const candidate = await client.request('pairing.request', {
    token: config.token,
    displayName: 'R4 isolated failover client',
  })
  emit({
    type: 'candidate',
    candidateId: candidate.candidateId,
    deviceId: client.deviceId,
    initialTransport,
    initialHistory,
    unauthRejected,
  })

  const confirmed = await readCommand()
  if (confirmed.type !== 'confirmed') throw new Error('expected pairing confirmation')
  client.close()

  // 2. Authorized reconnect via ordered failover -> falls through to Relay
  await client.reconnectWithBackoff({ initialDelayMs: 25, maxDelayMs: 50, maxAttempts: 2 })
  const transportAfterAuth = client.getActiveTransportKind()
  const epoch1 = client.getConnectionEpoch()
  const sessions = await client.request('session.list')
  const resume1 = await client.resumeSession('s1')
  const seqs1 = seqs(resume1)
  if (seqs1.length > 0) {
    await client.acknowledgeSessionSeq('s1', seqs1[seqs1.length - 1])
  }

  client.close()
  emit({
    type: 'after-first-sync',
    epoch1,
    transportAfterAuth,
    sessions,
    seqs1,
  })

  const resumeCmd = await readCommand()
  if (resumeCmd.type !== 'resume-now') throw new Error('expected resume-now')

  // 3. Reconnect-and-resume via failover while Host ingested events [2, 3] offline
  const resumedMap = await client.reconnectAndResume(['s1'], {
    initialDelayMs: 25,
    maxDelayMs: 50,
    maxAttempts: 2,
  })
  const transportAfterResume = client.getActiveTransportKind()
  const epoch2 = client.getConnectionEpoch()
  const resume2 = resumedMap.s1
  const seqs2 = seqs(resume2)
  if (seqs2.length > 0) {
    await client.acknowledgeSessionSeq('s1', seqs2[seqs2.length - 1])
  }

  // 4. Live stream event over Blind Relay
  const liveEventPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for live stream event')), 4000)
    const unsub = client.onEvent((evt) => {
      if (evt?.type === 'stream.event' && evt?.sessionId === 's1' && evt?.event?.seq === 4) {
        clearTimeout(timer)
        unsub()
        resolve(evt)
      }
    })
  })
  emit({ type: 'ready-for-live-event' })
  const liveEvt = await liveEventPromise

  // 5. Idempotent prompt + approval RPCs over Blind Relay
  const promptResult1 = await client.request(
    'prompt.submit',
    { sessionId: 's1', prompt: 'R4_REAL_PROMPT_MARKER' },
    { idempotencyKey: 'r4-real-idem-prompt' },
  )
  const promptResult2 = await client.request(
    'prompt.submit',
    { sessionId: 's1', prompt: 'R4_REAL_PROMPT_MARKER' },
    { idempotencyKey: 'r4-real-idem-prompt' },
  )
  const approvalResult = await client.request(
    'approval.respond',
    { callId: 'R4_REAL_APPROVAL_MARKER', decision: 'approved' },
    { idempotencyKey: 'r4-real-idem-approval' },
  )

  emit({
    type: 'awaiting-revoke',
    epoch2,
    transportAfterResume,
    seqs2,
    liveSeq: liveEvt.event?.seq,
    liveMarker: liveEvt.event?.data?.marker,
    promptResult1,
    promptResult2,
    approvalResult,
    failoverHistory: client.getFailoverHistory(),
    relayConnIdHex: client.getRelayConnIdHex(),
  })

  const revokeCmd = await readCommand()
  if (revokeCmd.type !== 'revoked') throw new Error('expected revoked')

  // 6. Wait for Relay peer kick -> verify immediate disconnect & post-revoke reconnect failure
  const disconnectStart = Date.now()
  while (client.isOpen() && Date.now() - disconnectStart < 3000) {
    await new Promise((r) => setTimeout(r, 20))
  }
  const openAfterRevoke = client.isOpen()

  let postRevokeRejected = false
  try {
    await client.reconnectWithBackoff({
      initialDelayMs: 25,
      maxDelayMs: 50,
      maxAttempts: 1,
    })
  } catch {
    postRevokeRejected = true
  }
  const openAfterPostRevokeAttempt = client.isOpen()
  client.close()

  emit({
    type: 'done',
    openAfterRevoke,
    postRevokeRejected,
    openAfterPostRevokeAttempt,
    reconnectDelaysCount: reconnectDelays.length,
  })
} finally {
  client.close()
  input.close()
}
