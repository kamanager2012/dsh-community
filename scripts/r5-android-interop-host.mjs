#!/usr/bin/env node

import { createServer } from 'node:http'
import { BlindRelayServer, createPairingBootstrapDescriptor, InMemoryDeviceTrustStore, InMemoryHostIdentityStore, PairingCoordinator, PairingTokenRegistry, RemoteHostRuntime } from '../packages/remote-adapter/dist/index.js'

const SESSION_ID = 's-r5-android-interop'
const PROMPT_MARKER = 'DSH_R5_ANDROID_SECRET_PROMPT_42'

const hostIdentityStore = new InMemoryHostIdentityStore()
const trustStore = new InMemoryDeviceTrustStore()
const tokenRegistry = new PairingTokenRegistry()
const pairingCoordinator = new PairingCoordinator(hostIdentityStore, trustStore, tokenRegistry)

const calls = {
  followup: 0,
  approval: 0,
  question: 0,
  blindFramesAudited: 0,
  plaintextLeaks: 0,
  lastSeqIngested: 0,
}

const seams = {
  async listSessions() {
    return [{ id: SESSION_ID, title: 'Android R5 Interop Session' }]
  },
  async assertSession(sessionId) {
    if (sessionId !== SESSION_ID) {
      throw new Error(`session not found: ${sessionId}`)
    }
  },
  async followup(sessionId, prompt) {
    calls.followup += 1
    calls.lastSeqIngested += 1
    runtime.ingestSessionEventBatch(SESSION_ID, {
      log: [
        {
          seq: calls.lastSeqIngested,
          type: 'assistant.delta',
          data: { sessionId, echo: prompt, turn: calls.followup },
        },
      ],
    })
    return { sessionId, prompt, turnId: `t-r5-${calls.followup}` }
  },
  async respondApproval(callId, decision) {
    calls.approval += 1
    calls.lastSeqIngested += 1
    runtime.ingestSessionEventBatch(SESSION_ID, {
      log: [
        {
          seq: calls.lastSeqIngested,
          type: 'approval.resolved',
          data: { callId, decision },
        },
      ],
    })
    return { callId, decision }
  },
  async respondQuestion(questionId, answer) {
    calls.question += 1
    return { questionId, answer }
  },
}

const relayServer = new BlindRelayServer({
  enabled: true,
  host: '127.0.0.1',
  port: 0,
  maxOpaquePayloadBytes: 65_536,
  maxFramesPerSecond: 200,
  onBlindFrame: (obs) => {
    calls.blindFramesAudited += 1
    const text = Buffer.from(obs.payload).toString('utf8')
    if (
      text.includes(PROMPT_MARKER) ||
      text.includes(SESSION_ID) ||
      text.includes('jsonrpc') ||
      text.includes('prompt.submit') ||
      text.includes('approval.respond')
    ) {
      calls.plaintextLeaks += 1
    }
  },
})

await relayServer.start()
const relayUrl = relayServer.getEndpointUrl()
if (!relayUrl) {
  throw new Error('BlindRelayServer did not yield an endpoint URL')
}
const hostKeyPair = await hostIdentityStore.loadOrCreate()
const hostFingerprint = hostKeyPair.identity.fingerprint
const relayRoomId = `room_${hostFingerprint.slice(0, 24)}`

const runtime = new RemoteHostRuntime({
  seams,
  trustStore,
  hostIdentityStore,
  pairingCoordinator,
  carrier: {
    enabled: true,
    host: '127.0.0.1',
    port: 0,
  },
  relay: {
    enabled: true,
    relayUrl,
    roomId: relayRoomId,
  },
})

await runtime.start()

const lanUrl = runtime.carrier.getEndpointUrl()
if (!lanUrl) {
  throw new Error('HostLanCarrier did not yield an endpoint URL')
}
const bootstrap = tokenRegistry.createToken({
  ttlMs: 120_000,
  allowedCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
  hostGeneration: hostKeyPair.identity.generation,
  trustDomainId: hostKeyPair.identity.trustDomainId,
})

const descriptor = createPairingBootstrapDescriptor({
  protocolVersion: 1,
  hostPublicKey: hostKeyPair.identity.publicKey,
  bootstrapToken: bootstrap.token,
  endpointUrl: lanUrl,
  expiresAt: bootstrap.expiresAt,
  signalingUrl: 'ws://127.0.0.1:9/signaling-unavailable',
  signalingRoomId: relayRoomId,
  stunUrls: ['stun:127.0.0.1:3478'],
  relayUrl,
  relayRoomId,
})

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

const controlServer = createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'GET' && reqUrl.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          followupCalls: calls.followup,
          approvalCalls: calls.approval,
          questionCalls: calls.question,
          blindFramesAudited: calls.blindFramesAudited,
          plaintextLeaks: calls.plaintextLeaks,
          lastSeqIngested: calls.lastSeqIngested,
        }),
      )
      return
    }
    if (req.method === 'POST' && reqUrl.pathname === '/confirm-pairing') {
      const body = await readJsonBody(req)
      const confirmed = await pairingCoordinator.confirmPairing({
        candidateId: body.candidateId,
        grantedCapabilities: ['observe', 'prompt', 'approve', 'answer-question'],
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, deviceId: confirmed.device.deviceId }))
      return
    }
    if (req.method === 'POST' && reqUrl.pathname === '/emit-event') {
      const body = await readJsonBody(req)
      calls.lastSeqIngested += 1
      runtime.ingestSessionEventBatch(SESSION_ID, {
        log: [
          {
            seq: calls.lastSeqIngested,
            type: body.type || 'approval.request',
            data: body.data || { callId: 'call-r5-1', tool: 'shell' },
          },
        ],
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, seq: calls.lastSeqIngested }))
      return
    }
    if (req.method === 'POST' && reqUrl.pathname === '/drop-lan') {
      await runtime.carrier.stop()
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method === 'POST' && reqUrl.pathname === '/revoke') {
      const body = await readJsonBody(req)
      trustStore.revokeSync(body.deviceId)
      runtime.carrier.disconnectDevice?.(body.deviceId)
      runtime.relay?.disconnectDevice?.(body.deviceId)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    if (req.method === 'POST' && reqUrl.pathname === '/shutdown') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      await Promise.allSettled([runtime.stop(), relayServer.stop()])
      controlServer.close()
      process.exit(0)
    }
    res.writeHead(404)
    res.end('not found')
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  }
})

await new Promise((resolve) => controlServer.listen(0, '127.0.0.1', resolve))
const controlAddr = controlServer.address()
const controlUrl = `http://127.0.0.1:${controlAddr.port}`

process.stdout.write(
  'READY ' +
    JSON.stringify({
      controlUrl,
      lanUrl,
      relayUrl,
      relayRoomId,
      sessionId: SESSION_ID,
      promptMarker: PROMPT_MARKER,
      pairingJson: JSON.stringify(descriptor),
    }) +
    '\n',
)
