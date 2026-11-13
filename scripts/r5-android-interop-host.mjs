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
  rename: 0,
  createSession: 0,
  abortTurn: 0,
  modelList: 0,
  modelSelect: 0,
  blindFramesAudited: 0,
  plaintextLeaks: 0,
  lastSeqIngested: 0,
  lastPromptAttachments: 0,
  lastPromptImageNames: [],
  lastSelectedModel: null,
  lastSelectedReasoningEffort: null,
  sessionTitle: 'Android R5 Interop Session',
  extraSessions: [],
}

const seams = {
  async listSessions() {
    return [{ id: SESSION_ID, title: calls.sessionTitle }, ...calls.extraSessions]
  },
  async assertSession(sessionId) {
    if (sessionId !== SESSION_ID && !calls.extraSessions.some((s) => s.id === sessionId)) {
      throw new Error(`session not found: ${sessionId}`)
    }
  },
  async createSession(params) {
    calls.createSession += 1
    const created = {
      id: `sess-r5-${calls.createSession}`,
      title: params?.title || `Created Session ${calls.createSession}`,
    }
    calls.extraSessions.push(created)
    return created
  },
  async renameSession(sessionId, title) {
    await seams.assertSession(sessionId)
    calls.rename += 1
    if (sessionId === SESSION_ID) {
      calls.sessionTitle = title
    } else {
      const target = calls.extraSessions.find((s) => s.id === sessionId)
      if (target) target.title = title
    }
    calls.lastSeqIngested += 1
    runtime.ingestSessionEventBatch(sessionId, {
      log: [
        {
          seq: calls.lastSeqIngested,
          type: 'session/title',
          data: { title },
        },
      ],
    })
    return { id: sessionId, title }
  },
  async followup(sessionId, prompt, options) {
    await seams.assertSession(sessionId)
    calls.followup += 1
    const attachments = Array.isArray(options?.attachments) ? options.attachments : []
    calls.lastPromptAttachments += attachments.length
    if (attachments.length > 0) {
      calls.lastPromptImageNames = attachments.map((a) => a.name || a.mediaType)
    }
    calls.lastSeqIngested += 1
    runtime.ingestSessionEventBatch(sessionId, {
      log: [
        {
          seq: calls.lastSeqIngested,
          type: 'assistant.delta',
          data: {
            sessionId,
            echo: prompt,
            turn: calls.followup,
            mode: options?.mode || 'followup',
            attachmentsCount: attachments.length,
          },
        },
      ],
    })
    return {
      sessionId,
      prompt,
      attachmentsCount: attachments.length,
      turnId: `t-r5-${calls.followup}`,
    }
  },
  async abortTurn(sessionId) {
    await seams.assertSession(sessionId)
    calls.abortTurn += 1
    return { aborted: true, sessionId }
  },
  async listModels(_sessionId) {
    calls.modelList += 1
    return {
      current: calls.lastSelectedModel
        ? {
            provider: calls.lastSelectedModel.provider,
            model: calls.lastSelectedModel.model,
            reasoningEffort: calls.lastSelectedReasoningEffort || 'medium',
          }
        : {
            provider: 'deepseek',
            model: 'deepseek-reasoner',
            reasoningEffort: 'medium',
          },
      models: [
        {
          provider: 'deepseek',
          providerName: 'DeepSeek',
          model: 'deepseek-chat',
          name: 'DeepSeek Chat',
          supportsImageInput: false,
          reasoningEfforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
          ],
          defaultReasoningEffort: 'low',
          contextWindow: 65536,
        },
        {
          provider: 'deepseek',
          providerName: 'DeepSeek',
          model: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          supportsImageInput: true,
          reasoningEfforts: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ],
          defaultReasoningEffort: 'medium',
          contextWindow: 131072,
        },
      ],
    }
  },
  async selectModel(sessionId, selection) {
    await seams.assertSession(sessionId)
    calls.modelSelect += 1
    calls.lastSelectedModel = {
      provider: selection.provider,
      model: selection.model,
    }
    calls.lastSelectedReasoningEffort = selection.reasoningEffort || null
    calls.lastSeqIngested += 1
    runtime.ingestSessionEventBatch(sessionId, {
      log: [
        {
          seq: calls.lastSeqIngested,
          type: 'session.model',
          data: {
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
          },
        },
      ],
    })
    return {
      ok: true,
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort || null,
    }
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
          renameCalls: calls.rename,
          createSessionCalls: calls.createSession,
          abortTurnCalls: calls.abortTurn,
          modelListCalls: calls.modelList,
          modelSelectCalls: calls.modelSelect,
          lastPromptAttachments: calls.lastPromptAttachments,
          lastPromptImageNames: calls.lastPromptImageNames,
          lastSelectedReasoningEffort: calls.lastSelectedReasoningEffort,
          sessionTitle: calls.sessionTitle,
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
